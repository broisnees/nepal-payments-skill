// Webhook endpoints and their delivery log (src/webhooks). Admin only, like alert channels: endpoints carry secrets.
import { WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_TYPE, newId, type WebhookDelivery, type WebhookEndpoint, type WebhookPayload } from "@paynp/shared";
import type { Hono } from "hono";
import { audit, requireProject } from "../lib/access.ts";
import { DAY, HttpError, appOrigin, badRequest, decodeCursor, notFound, now, page, parseEnv, parseJson, parseLimit, readJson, str } from "../lib/util.ts";
import { failPendingStatement, kick, secretsOf, send } from "../webhooks/deliver.ts";
import { maskSecret, newWebhookSecret } from "../webhooks/sign.ts";
import type { AppEnv } from "../types.ts";

export const MAX_ENDPOINTS = 10;
/** After a rotation the old secret keeps signing (as a second signature) for this long. */
export const ROTATION_GRACE_MS = DAY;

interface EndpointRow {
  id: string;
  project_id: string;
  env: string;
  url: string;
  description: string | null;
  events: string;
  secret: string;
  prev_secret: string | null;
  prev_secret_until: number | null;
  enabled: number;
  disabled_reason: string | null;
  failing_since: number | null;
  created_at: number;
}

interface DeliveryRow extends Omit<WebhookDelivery, "payload"> {
  payload: string;
}

function toEndpoint(r: EndpointRow, reveal = false): WebhookEndpoint {
  return {
    id: r.id,
    env: r.env as WebhookEndpoint["env"],
    url: r.url,
    description: r.description,
    events: r.events === "*" ? ["*"] : parseJson<string[]>(r.events, []),
    enabled: !!r.enabled,
    disabled_reason: r.disabled_reason,
    failing_since: r.failing_since,
    secret: reveal ? r.secret : maskSecret(r.secret),
    created_at: r.created_at,
  };
}

const toDelivery = (r: DeliveryRow): WebhookDelivery => ({ ...r, payload: parseJson<WebhookPayload>(r.payload, { type: r.type, timestamp: "", data: {} }) });

/** https, a public hostname, and not discerns itself (no loops). The Workers runtime cannot reach private networks. */
function endpointUrl(v: unknown, ownHost: string): string {
  if (typeof v !== "string" || !v.trim() || v.length > 2000) throw badRequest("url is required, at most 2000 characters");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw badRequest("url must be a URL");
  }
  if (u.protocol !== "https:") throw badRequest("url must start with https://");
  if (u.username || u.password) throw badRequest("url must not contain a user name or password");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
    throw badRequest("url needs a public hostname, not localhost or an IP address. For local testing use a tunnel such as cloudflared");
  }
  if (host === ownHost) throw badRequest("url must not point at discerns");
  return u.toString();
}

function eventsOf(v: unknown): string {
  if (v === undefined || v === null) return "*";
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string")) throw badRequest(`events must be a non-empty array of event types, or ["*"]`);
  if (v.includes("*")) return "*";
  const list = [...new Set(v as string[])];
  const bad = list.find((x) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(x));
  if (bad) throw badRequest(`unknown event type "${bad}". Use: ${WEBHOOK_EVENT_TYPES.join(", ")}`);
  return JSON.stringify(list);
}

export function registerWebhooks(api: Hono<AppEnv>) {
  const load = async (env: Env, projectId: string, id: string) => {
    const row = await env.DB.prepare("SELECT * FROM webhook_endpoints WHERE id = ? AND project_id = ?").bind(id, projectId).first<EndpointRow>();
    if (!row) throw notFound("webhook endpoint");
    return row;
  };

  api.get("/projects/:p/webhooks", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const envName = c.req.query("env");
    const rows = await c.env.DB.prepare(`SELECT * FROM webhook_endpoints WHERE project_id = ? ${envName ? "AND env = ?" : ""} ORDER BY created_at`)
      .bind(...[project.id, ...(envName ? [parseEnv(envName)] : [])])
      .all<EndpointRow>();
    return c.json({ items: rows.results.map((r) => toEndpoint(r)), next_cursor: null });
  });

  api.post("/projects/:p/webhooks", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const envName = parseEnv(typeof body.env === "string" ? body.env : undefined);
    const url = endpointUrl(body.url, new URL(appOrigin(c.env, c.req.raw)).hostname);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE project_id = ? AND env = ?").bind(project.id, envName).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ENDPOINTS) throw new HttpError(409, "limit_reached", `at most ${MAX_ENDPOINTS} webhook endpoints per environment`);
    const row: EndpointRow = {
      id: newId("we"),
      project_id: project.id,
      env: envName,
      url,
      description: str(body, "description", { max: 200 }) ?? null,
      events: eventsOf(body.events),
      secret: newWebhookSecret(),
      prev_secret: null,
      prev_secret_until: null,
      enabled: 1,
      disabled_reason: null,
      failing_since: null,
      created_at: now(),
    };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO webhook_endpoints (id, project_id, env, url, description, events, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(
        row.id, row.project_id, row.env, row.url, row.description, row.events, row.secret, row.created_at,
      ),
      audit(c.env, project.org_id, c.get("user").id, "webhook.create", row.id, { env: envName, url }),
    ]);
    // The create response is one of the places the secret is shown in full (also reveal and rotate).
    return c.json(toEndpoint(row, true), 201);
  });

  api.get("/projects/:p/webhooks/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    return c.json(toEndpoint(await load(c.env, project.id, c.req.param("id"))));
  });

  api.patch("/projects/:p/webhooks/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    const body = await readJson(c.req.raw);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw badRequest("enabled must be true or false");
    const next: EndpointRow = {
      ...row,
      url: body.url === undefined ? row.url : endpointUrl(body.url, new URL(appOrigin(c.env, c.req.raw)).hostname),
      description: body.description === undefined ? row.description : (str(body, "description", { max: 200 }) ?? null),
      events: body.events === undefined ? row.events : eventsOf(body.events),
    };
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    if (body.enabled === true && !row.enabled) Object.assign(next, { enabled: 1, disabled_reason: null, failing_since: null });
    if (body.enabled === false && row.enabled) {
      Object.assign(next, { enabled: 0, disabled_reason: "Turned off in the dashboard" });
      stmts.push(failPendingStatement(c.env, [row.id], "endpoint disabled", t));
    }
    stmts.unshift(
      c.env.DB.prepare("UPDATE webhook_endpoints SET url = ?, description = ?, events = ?, enabled = ?, disabled_reason = ?, failing_since = ? WHERE id = ?").bind(
        next.url, next.description, next.events, next.enabled, next.disabled_reason, next.failing_since, row.id,
      ),
    );
    stmts.push(audit(c.env, project.org_id, c.get("user").id, "webhook.update", row.id, { fields: Object.keys(body) }));
    await c.env.DB.batch(stmts);
    return c.json(toEndpoint(next));
  });

  api.delete("/projects/:p/webhooks/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").bind(row.id),
      c.env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(row.id),
      audit(c.env, project.org_id, c.get("user").id, "webhook.delete", row.id, { url: row.url }),
    ]);
    return c.body(null, 204);
  });

  api.get("/projects/:p/webhooks/:id/secret", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    await audit(c.env, project.org_id, c.get("user").id, "webhook.reveal", row.id).run();
    return c.json({ secret: row.secret });
  });

  api.post("/projects/:p/webhooks/:id/rotate", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    const next = { ...row, secret: newWebhookSecret(), prev_secret: row.secret, prev_secret_until: now() + ROTATION_GRACE_MS };
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE webhook_endpoints SET secret = ?, prev_secret = ?, prev_secret_until = ? WHERE id = ?").bind(next.secret, next.prev_secret, next.prev_secret_until, row.id),
      audit(c.env, project.org_id, c.get("user").id, "webhook.rotate", row.id),
    ]);
    return c.json(toEndpoint(next, true));
  });

  // One signed POST right now, no retries. Sent even when the endpoint is off, so it can be checked before turning it on.
  api.post("/projects/:p/webhooks/:id/test", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    const t = now();
    const eventId = newId("msg", t);
    const payload: WebhookPayload = {
      type: WEBHOOK_TEST_TYPE,
      timestamp: new Date(t).toISOString(),
      data: { message: "Test event from discerns. Your endpoint verified the signature if you are reading this in your logs.", project: { id: project.id, name: project.name }, endpoint_id: row.id, env: row.env },
    };
    const body = JSON.stringify(payload);
    const res = await send(row.url, secretsOf(row, t), eventId, body, t);
    const delivery: DeliveryRow = {
      id: newId("whd", t),
      endpoint_id: row.id,
      event_id: eventId,
      type: WEBHOOK_TEST_TYPE,
      attempt_id: null,
      status: res.ok ? "delivered" : "failed",
      attempts: 1,
      next_at: null,
      created_at: t,
      last_at: now(),
      last_status: res.status,
      last_error: res.error,
      last_ms: res.ms,
      last_response: res.response,
      payload: body,
    };
    await c.env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, project_id, env, type, attempt_id, payload, created_at, status, attempts, next_at, last_at, last_status, last_error, last_ms, last_response)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
    )
      .bind(delivery.id, row.id, eventId, project.id, row.env, WEBHOOK_TEST_TYPE, body, t, delivery.status, delivery.last_at, res.status, res.error, res.ms, res.response)
      .run();
    return c.json({ ok: res.ok, delivery: toDelivery(delivery) }, res.ok ? 200 : 502);
  });

  api.get("/projects/:p/webhooks/:id/deliveries", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    const status = c.req.query("status");
    if (status && !["pending", "delivered", "failed"].includes(status)) throw badRequest("status must be pending, delivered or failed");
    const limit = parseLimit(c.req.query("limit"), 25, 100);
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT id, endpoint_id, event_id, type, attempt_id, status, attempts, next_at, created_at, last_at, last_status, last_error, last_ms, last_response, payload
       FROM webhook_deliveries WHERE endpoint_id = ? ${status ? "AND status = ?" : ""} ${cur ? "AND (created_at, id) < (?, ?)" : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...[row.id, ...(status ? [status] : []), ...(cur ?? []), limit + 1])
      .all<DeliveryRow>();
    const p = page(rows.results, limit, (r) => [r.created_at, r.id]);
    return c.json({ items: p.items.map(toDelivery), next_cursor: p.next_cursor });
  });

  api.post("/projects/:p/webhooks/:id/deliveries/:did/resend", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await load(c.env, project.id, c.req.param("id"));
    if (!row.enabled) throw new HttpError(409, "endpoint_disabled", "turn the endpoint on before resending");
    const d = await c.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ? AND endpoint_id = ?").bind(c.req.param("did"), row.id).first<DeliveryRow>();
    if (!d) throw notFound("delivery");
    if (d.type === WEBHOOK_TEST_TYPE) throw badRequest("send a new test event instead");
    const t = now();
    // A fresh retry schedule; the webhook-id stays the same, so a receiver that already has it can ignore it.
    await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_at = ? WHERE id = ?").bind(t, d.id).run();
    c.executionCtx.waitUntil(kick(c.env, project.id, row.env));
    return c.json(toDelivery({ ...d, status: "pending", attempts: 0, next_at: t }), 202);
  });
}
