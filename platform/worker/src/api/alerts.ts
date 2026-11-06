// Alert channels, rules and incidents.
import { newId, type AlertChannel, type AlertRule, type ChannelType, type Incident, type RuleType } from "@paynp/shared";
import type { Hono } from "hono";
import { RULE_TYPES, normalizeParams, type IncidentRow, type RuleRow } from "../alerts/engine.ts";
import { projectLink, sendToChannel, type ChannelRow } from "../alerts/notify.ts";
import { audit, requireProject } from "../lib/access.ts";
import { badRequest, decodeCursor, isEmail, notFound, now, page, parseEnv, parseJson, parseLimit, randomString, readJson, str } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";

const CHANNEL_TYPES: ChannelType[] = ["email", "slack", "discord", "webhook"];

function httpUrl(v: unknown, name: string): string {
  if (typeof v !== "string") throw badRequest(`${name} is required`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw badRequest(`${name} must be a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest(`${name} must be http(s)`);
  return u.toString();
}

/** Validates a channel config. `prev` keeps the stored secret when an update leaves it out or sends the masked value. */
function channelConfig(type: ChannelType, input: unknown, prev?: Record<string, unknown>): Record<string, unknown> {
  const cfg = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  switch (type) {
    case "email": {
      const to = Array.isArray(cfg.to) ? cfg.to : typeof cfg.to === "string" ? [cfg.to] : [];
      const list = to.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (!list.length || list.length > 50 || !list.every(isEmail)) throw badRequest("email channels need config.to: 1 to 50 email addresses");
      return { to: list };
    }
    case "slack":
    case "discord": {
      const url = cfg.webhook_url === undefined && prev ? String(prev.webhook_url) : String(cfg.webhook_url).includes("****") && prev ? String(prev.webhook_url) : httpUrl(cfg.webhook_url, "config.webhook_url");
      return { webhook_url: url };
    }
    case "webhook": {
      const url = cfg.url === undefined && prev ? String(prev.url) : httpUrl(cfg.url, "config.url");
      let secret = typeof cfg.secret === "string" && cfg.secret && !cfg.secret.includes("****") ? cfg.secret : (prev?.secret as string | undefined);
      if (secret !== undefined && (secret.length < 16 || secret.length > 200)) throw badRequest("config.secret must be 16 to 200 chars");
      secret ??= `whsec_${randomString(32)}`;
      return { url, secret };
    }
  }
}

const mask = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 6)}****${s.slice(-4)}`);

function toChannel(row: ChannelRow, reveal = false): AlertChannel {
  const cfg = parseJson<Record<string, unknown>>(row.config, {});
  if (!reveal) {
    if (typeof cfg.secret === "string") cfg.secret = mask(cfg.secret);
    if (typeof cfg.webhook_url === "string") {
      const u = new URL(cfg.webhook_url);
      cfg.webhook_url = `${u.origin}/****${u.pathname.slice(-4)}`;
    }
  }
  return { id: row.id, type: row.type, name: row.name, config: cfg, created_at: row.created_at };
}

function toRule(r: RuleRow): AlertRule {
  return {
    id: r.id,
    env: r.env as AlertRule["env"],
    type: r.type,
    params: parseJson(r.params, {}),
    channel_ids: parseJson(r.channel_ids, []),
    cooldown_min: r.cooldown_min,
    enabled: !!r.enabled,
    created_at: r.created_at,
  };
}

function toIncident(r: IncidentRow & { rule_type?: string }): Incident & { rule_type?: string; attempt_id: string | null; env: string | null } {
  return {
    id: r.id,
    rule_id: r.rule_id,
    rule_type: r.rule_type,
    state: r.state,
    opened_at: r.opened_at,
    resolved_at: r.resolved_at,
    last_notified_at: r.last_notified_at,
    summary: r.summary,
    context: parseJson(r.context, null),
    attempt_id: r.attempt_id,
    env: r.env,
  };
}

async function checkChannelIds(env: Env, projectId: string, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw badRequest("channel_ids must be a list of channel ids");
  const unique = [...new Set(ids as string[])];
  if (unique.length > 20) throw badRequest("at most 20 channels per rule");
  if (unique.length) {
    const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM alert_channels WHERE project_id = ? AND id IN (${unique.map(() => "?").join(",")})`).bind(projectId, ...unique).first<{ n: number }>();
    if ((found?.n ?? 0) !== unique.length) throw badRequest("unknown channel id in channel_ids");
  }
  return unique;
}

function cooldown(v: unknown, def: number): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_080) throw badRequest("cooldown_min must be an integer from 0 to 10080");
  return v;
}

export function registerAlerts(api: Hono<AppEnv>) {
  api.get("/projects/:p/channels", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const rows = await c.env.DB.prepare("SELECT * FROM alert_channels WHERE project_id = ? ORDER BY created_at LIMIT 200").bind(project.id).all<ChannelRow>();
    return c.json({ items: rows.results.map((r) => toChannel(r)), next_cursor: null });
  });

  api.post("/projects/:p/channels", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const type = body.type as ChannelType;
    if (!CHANNEL_TYPES.includes(type)) throw badRequest("type must be email, slack, discord or webhook");
    const name = str(body, "name", { max: 100 }) ?? type;
    const config = channelConfig(type, body.config);
    const row: ChannelRow = { id: newId("chn"), project_id: project.id, type, name, config: JSON.stringify(config), created_at: now() };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO alert_channels (id, project_id, type, name, config, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(row.id, row.project_id, row.type, row.name, row.config, row.created_at),
      audit(c.env, project.org_id, c.get("user").id, "channel.create", row.id, { type }),
    ]);
    // The create response is the one place the webhook secret is shown in full.
    return c.json(toChannel(row, true), 201);
  });

  api.patch("/projects/:p/channels/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await c.env.DB.prepare("SELECT * FROM alert_channels WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).first<ChannelRow>();
    if (!row) throw notFound("channel");
    const body = await readJson(c.req.raw);
    const name = str(body, "name", { max: 100 }) ?? row.name;
    const config = body.config === undefined ? parseJson(row.config, {}) : channelConfig(row.type, body.config, parseJson(row.config, {}));
    const next = { ...row, name, config: JSON.stringify(config) };
    await c.env.DB.prepare("UPDATE alert_channels SET name = ?, config = ? WHERE id = ?").bind(next.name, next.config, row.id).run();
    return c.json(toChannel(next));
  });

  api.delete("/projects/:p/channels/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const r = await c.env.DB.prepare("DELETE FROM alert_channels WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).run();
    if (!r.meta.changes) throw notFound("channel");
    await audit(c.env, project.org_id, c.get("user").id, "channel.delete", c.req.param("id")).run();
    return c.body(null, 204);
  });

  api.post("/projects/:p/channels/:id/test", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await c.env.DB.prepare("SELECT * FROM alert_channels WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).first<ChannelRow>();
    if (!row) throw notFound("channel");
    const result = await sendToChannel(
      c.env,
      row,
      {
        kind: "test",
        title: `Test alert from discerns`,
        lines: [`Channel "${row.name}" in project ${project.name} works.`],
        link: projectLink(c.env, project.id, "/alerts"),
        payload: { project: { id: project.id, name: project.name }, channel: { id: row.id, name: row.name } },
      },
      [],
    );
    return c.json(result, result.ok ? 200 : 502);
  });

  api.get("/projects/:p/rules", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const envFilter = c.req.query("env");
    const rows = await c.env.DB.prepare(`SELECT * FROM alert_rules WHERE project_id = ? ${envFilter ? "AND env = ?" : ""} ORDER BY created_at LIMIT 200`)
      .bind(project.id, ...(envFilter ? [parseEnv(envFilter)] : []))
      .all<RuleRow>();
    return c.json({ items: rows.results.map(toRule), next_cursor: null });
  });

  api.post("/projects/:p/rules", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const type = body.type as RuleType;
    if (!RULE_TYPES.includes(type)) throw badRequest(`type must be one of ${RULE_TYPES.join(", ")}`);
    if (body.env !== undefined && body.env !== "test" && body.env !== "live") throw badRequest("env must be test or live");
    const rule: RuleRow = {
      id: newId("rul"),
      project_id: project.id,
      env: parseEnv(body.env as string | undefined),
      type,
      params: JSON.stringify(normalizeParams(type, body.params)),
      channel_ids: JSON.stringify(await checkChannelIds(c.env, project.id, body.channel_ids ?? [])),
      cooldown_min: cooldown(body.cooldown_min, 30),
      enabled: body.enabled === false ? 0 : 1,
      created_at: now(),
    };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO alert_rules (id, project_id, env, type, params, channel_ids, cooldown_min, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        rule.id, rule.project_id, rule.env, rule.type, rule.params, rule.channel_ids, rule.cooldown_min, rule.enabled, rule.created_at,
      ),
      audit(c.env, project.org_id, c.get("user").id, "rule.create", rule.id, { type }),
    ]);
    return c.json(toRule(rule), 201);
  });

  api.patch("/projects/:p/rules/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).first<RuleRow>();
    if (!row) throw notFound("rule");
    const body = await readJson(c.req.raw);
    if (body.env !== undefined && body.env !== "test" && body.env !== "live") throw badRequest("env must be test or live");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw badRequest("enabled must be a boolean");
    const next: RuleRow = {
      ...row,
      env: body.env === undefined ? row.env : (body.env as string),
      params: body.params === undefined ? row.params : JSON.stringify(normalizeParams(row.type, body.params)),
      channel_ids: body.channel_ids === undefined ? row.channel_ids : JSON.stringify(await checkChannelIds(c.env, project.id, body.channel_ids)),
      cooldown_min: cooldown(body.cooldown_min, row.cooldown_min),
      enabled: body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
    };
    await c.env.DB.prepare("UPDATE alert_rules SET env = ?, params = ?, channel_ids = ?, cooldown_min = ?, enabled = ? WHERE id = ?")
      .bind(next.env, next.params, next.channel_ids, next.cooldown_min, next.enabled, row.id)
      .run();
    return c.json(toRule(next));
  });

  api.delete("/projects/:p/rules/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("DELETE FROM alert_rules WHERE id = ? AND project_id = ?").bind(id, project.id).run();
    if (!r.meta.changes) throw notFound("rule");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE alert_incidents SET state = 'resolved', resolved_at = ?, pending = 0 WHERE rule_id = ? AND state = 'firing'").bind(now(), id),
      audit(c.env, project.org_id, c.get("user").id, "rule.delete", id),
    ]);
    return c.body(null, 204);
  });

  api.get("/projects/:p/incidents", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const state = c.req.query("state");
    if (state && state !== "firing" && state !== "resolved") throw badRequest("state must be firing or resolved");
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT i.*, r.type AS rule_type FROM alert_incidents i LEFT JOIN alert_rules r ON r.id = i.rule_id WHERE i.project_id = ?
       ${state ? "AND i.state = ?" : ""} ${cur ? "AND (i.opened_at, i.id) < (?, ?)" : ""} ORDER BY i.opened_at DESC, i.id DESC LIMIT ?`,
    )
      .bind(...[project.id, ...(state ? [state] : []), ...(cur ?? []), limit + 1])
      .all<IncidentRow & { rule_type: string }>();
    const p = page(rows.results, limit, (r) => [r.opened_at, r.id]);
    return c.json({ items: p.items.map(toIncident), next_cursor: p.next_cursor });
  });
}
