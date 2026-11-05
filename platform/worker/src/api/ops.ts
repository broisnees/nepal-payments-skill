// Merchant operations API (SPEC-v2 sections 3 and 4.1 to 4.4): action endpoint, actions log, refund queue,
// "I already paid" lookup, status links, payment ops view, re-check and the go-live doctor.
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  type ActionEndpoint,
  type DoctorCheck,
  type DoctorCode,
  type DoctorFinding,
  type DoctorReport,
  type Env as PayEnv,
  type LookupMatch,
  type LookupQueryKind,
  type LookupResult,
  type PaymentOps,
  type RefundCase,
  type RefundKind,
  type RefundStatus,
  type StatusLink,
} from "@paynp/shared";
import type { Context, Hono } from "hono";
import { audit, requireProject } from "../lib/access.ts";
import { DAY, HttpError, appOrigin, badRequest, decodeCursor, notFound, now, page, parseEnv, parseLimit, parseTime, randomString, randomToken, readJson, sha256Hex, str } from "../lib/util.ts";
import { sendAction, toAction, type ActionRow, type EndpointRow } from "../ops/actions.ts";
import { REFUND_API_GATEWAYS, checklist, markStep } from "../ops/checklist.ts";
import { customerHash, looksLikeEmail, looksLikePhone, normaliseEmail, normalisePhone } from "../ops/customer.ts";
import { toSummary, verdictFor } from "../ops/verdict.ts";
import type { AppEnv, PaymentRow, ProjectRow } from "../types.ts";

interface CaseRow {
  id: string;
  project_id: string;
  env: string;
  kind: RefundKind;
  status: RefundStatus;
  attempt_id: string;
  related_attempt_id: string | null;
  gateway: string;
  amount_paisa: number;
  reason: string | null;
  checklist: string | null;
  refund_ref: string | null;
  action_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
}

interface FindingRow {
  project_id: string;
  env: string;
  code: DoctorCode;
  severity: "critical" | "warning";
  gateway: string | null;
  first_seen: number;
  last_seen: number;
  count: number;
  example_attempt: string | null;
  resolved_at: number | null;
}

const REFUND_STATUSES: RefundStatus[] = ["open", "requested", "refunded", "dismissed", "failed"];
const REFUND_KINDS: RefundKind[] = ["duplicate", "manual", "customer_request"];
const CLOSED: RefundStatus[] = ["refunded", "dismissed"];

const maskSecret = (s: string) => `${s.slice(0, 10)}****${s.slice(-4)}`;
const toEndpoint = (r: EndpointRow, reveal = false): ActionEndpoint => ({
  env: r.env as PayEnv,
  url: r.url,
  secret: reveal ? r.secret : maskSecret(r.secret),
  created_at: r.created_at,
  last_ok_at: r.last_ok_at,
  last_error: r.last_error,
});

function envFrom(c: Context<AppEnv>, body?: Record<string, unknown>): "test" | "live" {
  const raw = body?.env ?? c.req.query("env");
  if (raw !== undefined && raw !== "test" && raw !== "live") throw badRequest("env must be test or live");
  return parseEnv(raw as string | undefined);
}

function endpointUrl(v: unknown, envName: string): string {
  if (typeof v !== "string" || !v) throw badRequest("url is required");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw badRequest("url must be a URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (envName === "test" || local))) throw badRequest("url must be https (http is allowed for the test env and localhost)");
  return u.toString();
}

async function getEndpoint(env: Env, projectId: string, envName: string): Promise<EndpointRow | null> {
  return env.DB.prepare("SELECT * FROM action_endpoints WHERE project_id = ? AND env = ?").bind(projectId, envName).first<EndpointRow>();
}

async function paymentsByAttempt(env: Env, projectId: string, envName: string, ids: string[]): Promise<Map<string, PaymentRow>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, PaymentRow>();
  for (let i = 0; i < unique.length; i += 90) {
    const part = unique.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT * FROM payments WHERE project_id = ? AND env = ? AND attempt_id IN (${part.map(() => "?").join(",")})`)
      .bind(projectId, envName, ...part)
      .all<PaymentRow>();
    for (const p of r.results) out.set(p.attempt_id, p);
  }
  return out;
}

function toCase(r: CaseRow, pays: Map<string, PaymentRow>, hasEndpoint: boolean): RefundCase {
  const p = pays.get(r.attempt_id);
  const rel = r.related_attempt_id ? pays.get(r.related_attempt_id) : undefined;
  const hasApi = REFUND_API_GATEWAYS.has(r.gateway);
  return {
    id: r.id,
    env: r.env as PayEnv,
    kind: r.kind,
    status: r.status,
    attempt_id: r.attempt_id,
    related_attempt_id: r.related_attempt_id,
    gateway: r.gateway,
    amount_paisa: r.amount_paisa,
    reason: r.reason,
    checklist: checklist(r.gateway, hasEndpoint, p?.provider_ref ?? null, r.checklist),
    refund_ref: r.refund_ref,
    action_id: r.action_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
    resolved_by: r.resolved_by,
    note: r.note,
    payment: p ? toSummary(p) : null,
    related: rel ? toSummary(rel) : null,
    can_send: hasApi && hasEndpoint,
    has_refund_api: hasApi,
  };
}

async function casesWithPayments(env: Env, projectId: string, envName: string, rows: CaseRow[]): Promise<RefundCase[]> {
  const [pays, ep] = await Promise.all([
    paymentsByAttempt(env, projectId, envName, rows.flatMap((r) => [r.attempt_id, ...(r.related_attempt_id ? [r.related_attempt_id] : [])])),
    rows.length ? getEndpoint(env, projectId, envName) : null,
  ]);
  return rows.map((r) => toCase(r, pays, !!ep));
}

async function loadCase(c: Context<AppEnv>, projectId: string): Promise<CaseRow> {
  const row = await c.env.DB.prepare("SELECT * FROM refund_cases WHERE id = ? AND project_id = ?").bind(c.req.param("id"), projectId).first<CaseRow>();
  if (!row) throw notFound("refund case");
  return row;
}

const refundReason = (r: CaseRow) =>
  r.reason === "same_order" || r.reason === "same_customer_amount" ? `Duplicate of ${r.related_attempt_id} (${r.reason === "same_order" ? "same order" : "same customer and amount"})` : r.reason;

/** Rupees ("1500", "1,500.50") or exact paisa. */
function parseAmount(q: Record<string, string>): number | null {
  if (q.amount_paisa) {
    const n = Number(q.amount_paisa);
    if (!Number.isSafeInteger(n) || n < 0) throw badRequest("amount_paisa must be a non-negative integer");
    return n;
  }
  if (q.amount) {
    const n = Number(q.amount.replace(/[,\s]/g, "").replace(/^rs\.?/i, ""));
    if (!Number.isFinite(n) || n < 0) throw badRequest("amount must be rupees, like 1500 or 1500.50");
    return Math.round(n * 100);
  }
  return null;
}

export function registerOps(api: Hono<AppEnv>) {
  // ---- Action endpoint (3) ----

  api.get("/projects/:p/action-endpoint", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await getEndpoint(c.env, project.id, envFrom(c));
    if (!row) throw notFound("action endpoint");
    return c.json(toEndpoint(row));
  });

  api.put("/projects/:p/action-endpoint", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const envName = envFrom(c, body);
    const url = endpointUrl(body.url, envName);
    const prev = await getEndpoint(c.env, project.id, envName);
    const fresh = !prev || body.rotate === true;
    const row: EndpointRow = prev
      ? { ...prev, url, secret: fresh ? `pas_${randomString(40)}` : prev.secret, last_error: null }
      : { project_id: project.id, env: envName, url, secret: `pas_${randomString(40)}`, created_at: now(), last_ok_at: null, last_error: null };
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO action_endpoints (project_id, env, url, secret, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, env) DO UPDATE SET url = excluded.url, secret = excluded.secret, last_error = NULL`,
      ).bind(row.project_id, row.env, row.url, row.secret, row.created_at),
      audit(c.env, project.org_id, c.get("user").id, prev ? (fresh ? "action_endpoint.rotate" : "action_endpoint.update") : "action_endpoint.create", project.id, { env: envName }),
    ]);
    // The secret is shown in full only when it was just created or rotated.
    return c.json(toEndpoint(row, fresh), prev ? 200 : 201);
  });

  api.delete("/projects/:p/action-endpoint", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const envName = envFrom(c);
    const r = await c.env.DB.prepare("DELETE FROM action_endpoints WHERE project_id = ? AND env = ?").bind(project.id, envName).run();
    if (!r.meta.changes) throw notFound("action endpoint");
    await audit(c.env, project.org_id, c.get("user").id, "action_endpoint.delete", project.id, { env: envName }).run();
    return c.body(null, 204);
  });

  api.post("/projects/:p/action-endpoint/test", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const ep = await getEndpoint(c.env, project.id, envFrom(c, body));
    if (!ep) throw notFound("action endpoint");
    const action = await sendAction(c.env, ep, { kind: "ping", attempt_id: "", gateway: "", order_id: null, amount_paisa: null, provider_ref: null }, c.get("user").email);
    return c.json(action, action.status === "ok" ? 200 : 502);
  });

  api.get("/projects/:p/actions", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = envFrom(c);
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const attempt = c.req.query("attempt_id");
    const rows = await c.env.DB.prepare(
      `SELECT * FROM actions WHERE project_id = ? AND env = ? ${attempt ? "AND attempt_id = ?" : ""} ${cur ? "AND (created_at, id) < (?, ?)" : ""}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(project.id, envName, ...(attempt ? [attempt] : []), ...(cur ?? []), limit + 1)
      .all<ActionRow>();
    const p = page(rows.results, limit, (r) => [r.created_at, r.id]);
    return c.json({ items: p.items.map(toAction), next_cursor: p.next_cursor });
  });

  // ---- Refund queue (4.1) ----

  api.get("/projects/:p/refunds", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = envFrom(c);
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    const where = ["project_id = ?", "env = ?"];
    const args: (string | number)[] = [project.id, envName];
    if (q.status) {
      const list = q.status.split(",").filter(Boolean);
      if (!list.every((s) => REFUND_STATUSES.includes(s as RefundStatus))) throw badRequest(`status must be among ${REFUND_STATUSES.join(", ")}`);
      where.push(`status IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    }
    if (q.kind) {
      if (!REFUND_KINDS.includes(q.kind as RefundKind)) throw badRequest(`kind must be one of ${REFUND_KINDS.join(", ")}`);
      where.push("kind = ?");
      args.push(q.kind);
    }
    if (q.attempt_id) where.push("attempt_id = ?"), args.push(q.attempt_id);
    if (cur) where.push("(created_at, id) < (?, ?)"), args.push(...cur);
    const [rows, open] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT * FROM refund_cases WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...args, limit + 1),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM refund_cases WHERE project_id = ? AND env = ? AND status IN ('open', 'requested', 'failed')").bind(project.id, envName),
    ]);
    const p = page(rows.results as CaseRow[], limit, (r) => [r.created_at, r.id]);
    return c.json({ items: await casesWithPayments(c.env, project.id, envName, p.items), next_cursor: p.next_cursor, open_count: (open.results[0] as { n: number }).n });
  });

  api.get("/projects/:p/refunds/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const row = await loadCase(c, project.id);
    return c.json((await casesWithPayments(c.env, project.id, row.env, [row]))[0]);
  });

  api.post("/projects/:p/refunds", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const envName = envFrom(c, body);
    const attempt = str(body, "attempt_id", { required: true, max: 128 })!;
    const reason = str(body, "reason", { required: true, max: 500 })!;
    const kind = (body.kind ?? "manual") as RefundKind;
    if (kind !== "manual" && kind !== "customer_request") throw badRequest("kind must be manual or customer_request");
    const pay = (await paymentsByAttempt(c.env, project.id, envName, [attempt])).get(attempt);
    if (!pay) throw notFound("payment");
    const left = pay.amount_paisa == null ? null : pay.amount_paisa - (pay.refunded_paisa ?? 0);
    let amount = left;
    if (body.amount_paisa !== undefined) {
      if (!Number.isSafeInteger(body.amount_paisa) || (body.amount_paisa as number) <= 0) throw badRequest("amount_paisa must be a positive integer");
      amount = body.amount_paisa as number;
      if (left !== null && amount > left) throw badRequest(`amount_paisa is more than the ${left} paisa not yet refunded`);
    }
    if (amount === null || amount <= 0) throw badRequest("amount_paisa is required: the payment has no amount left to refund");
    const t = now();
    const row: CaseRow = {
      id: `rfc_${randomString(24).toLowerCase()}`, project_id: project.id, env: envName, kind, status: "open", attempt_id: attempt, related_attempt_id: null,
      gateway: pay.gateway, amount_paisa: amount, reason, checklist: null, refund_ref: null, action_id: null, created_at: t, updated_at: t, resolved_at: null, resolved_by: null, note: null,
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO refund_cases (id, project_id, env, kind, status, attempt_id, gateway, amount_paisa, reason, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)",
      ).bind(row.id, project.id, envName, kind, attempt, pay.gateway, amount, reason, t, t),
      audit(c.env, project.org_id, c.get("user").id, "refund.create", row.id, { attempt_id: attempt, amount_paisa: amount }),
    ]);
    return c.json((await casesWithPayments(c.env, project.id, envName, [row]))[0], 201);
  });

  api.patch("/projects/:p/refunds/:id", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await loadCase(c, project.id);
    const body = await readJson(c.req.raw);
    const by = c.get("user").email;
    const t = now();
    const next: CaseRow = { ...row, updated_at: t };
    if (body.status !== undefined) {
      if (!REFUND_STATUSES.includes(body.status as RefundStatus)) throw badRequest(`status must be one of ${REFUND_STATUSES.join(", ")}`);
      next.status = body.status as RefundStatus;
      if (CLOSED.includes(next.status) && !CLOSED.includes(row.status)) Object.assign(next, { resolved_at: t, resolved_by: by });
      if (!CLOSED.includes(next.status)) Object.assign(next, { resolved_at: null, resolved_by: null });
    }
    const step = str(body, "checklist_step_done", { max: 40 });
    if (step) {
      const ep = await getEndpoint(c.env, project.id, row.env);
      if (!checklist(row.gateway, !!ep, null, null).some((s) => s.id === step)) throw badRequest(`unknown checklist step: ${step}`);
      next.checklist = markStep(row.checklist, step, by, t);
    }
    const ref = str(body, "refund_ref", { max: 200 });
    if (ref) {
      next.refund_ref = ref;
      next.checklist = markStep(next.checklist, "record", by, t);
    }
    if (body.note !== undefined) next.note = str(body, "note", { max: 2000 }) ?? null;
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE refund_cases SET status = ?, checklist = ?, refund_ref = ?, note = ?, updated_at = ?, resolved_at = ?, resolved_by = ? WHERE id = ?").bind(
        next.status, next.checklist, next.refund_ref, next.note, t, next.resolved_at, next.resolved_by, row.id,
      ),
      audit(c.env, project.org_id, c.get("user").id, "refund.update", row.id, { status: next.status, step: step ?? null }),
    ]);
    return c.json((await casesWithPayments(c.env, project.id, row.env, [next]))[0]);
  });

  api.post("/projects/:p/refunds/:id/send", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const row = await loadCase(c, project.id);
    if (CLOSED.includes(row.status)) throw new HttpError(409, "conflict", `the case is already ${row.status}`);
    const ep = await getEndpoint(c.env, project.id, row.env);
    if (!ep) throw new HttpError(409, "no_action_endpoint", "add an action endpoint for this env first (Settings, Action endpoint)");
    const pay = (await paymentsByAttempt(c.env, project.id, row.env, [row.attempt_id])).get(row.attempt_id);
    const by = c.get("user").email;
    const t = now();
    // Mark requested first so two admins clicking at once do not both send.
    const claim = await c.env.DB.prepare("UPDATE refund_cases SET status = 'requested', updated_at = ? WHERE id = ? AND status IN ('open', 'failed')").bind(t, row.id).run();
    if (!claim.meta.changes) throw new HttpError(409, "conflict", "a refund for this case is already in flight");
    const action = await sendAction(
      c.env,
      ep,
      {
        kind: "refund",
        attempt_id: row.attempt_id,
        gateway: row.gateway,
        order_id: pay?.order_id ?? null,
        amount_paisa: pay?.amount_paisa ?? null,
        provider_ref: pay?.provider_ref ?? null,
        refund: { amount_paisa: row.amount_paisa, reason: refundReason(row) },
      },
      by,
      t,
    );
    const ok = action.status === "ok";
    const done = now();
    // The merchant's SDK reports payment.refunded before it answers, so ingest may already have closed the case
    // (status refunded, resolved_by auto). The action id, the reply's refund ref and the checklist step always land;
    // status, resolution and the failure note only while the case is still 'requested'.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE refund_cases SET action_id = ?1, refund_ref = COALESCE(?2, refund_ref), checklist = ?3, updated_at = ?4,
           status = CASE WHEN status = 'requested' THEN ?5 ELSE status END,
           resolved_at = CASE WHEN status = 'requested' THEN ?6 ELSE resolved_at END,
           resolved_by = CASE WHEN status = 'requested' OR resolved_by = 'auto' THEN ?7 ELSE resolved_by END,
           note = CASE WHEN status = 'requested' THEN ?8 ELSE note END
         WHERE id = ?9`,
      ).bind(
        action.id, action.response?.refund_ref ?? null, ok ? markStep(row.checklist, "send", by, done) : row.checklist, done,
        ok ? "refunded" : "failed", ok ? done : null, ok ? by : null, ok ? row.note : `Send failed: ${action.response?.error ?? "unknown error"}`, row.id,
      ),
      audit(c.env, project.org_id, c.get("user").id, "refund.send", row.id, { action_id: action.id, ok }),
    ]);
    const fresh = await c.env.DB.prepare("SELECT * FROM refund_cases WHERE id = ?").bind(row.id).first<CaseRow>();
    return c.json({ case: (await casesWithPayments(c.env, project.id, row.env, [fresh!]))[0], action }, ok ? 200 : 502);
  });

  api.post("/projects/:p/payments/:attempt/recheck", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const envName = envFrom(c, body);
    const attempt = c.req.param("attempt");
    const pay = (await paymentsByAttempt(c.env, project.id, envName, [attempt])).get(attempt);
    if (!pay) throw notFound("payment");
    const ep = await getEndpoint(c.env, project.id, envName);
    if (!ep) throw new HttpError(409, "no_action_endpoint", "add an action endpoint for this env first (Settings, Action endpoint)");
    const action = await sendAction(
      c.env, ep,
      { kind: "recheck", attempt_id: attempt, gateway: pay.gateway, order_id: pay.order_id, amount_paisa: pay.amount_paisa, provider_ref: pay.provider_ref },
      c.get("user").email,
    );
    return c.json(action, action.status === "ok" ? 200 : 502);
  });

  // ---- Lookup and status links (4.2) ----

  api.get("/projects/:p/lookup", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = envFrom(c);
    const text = (q.q ?? "").trim().slice(0, 200);
    const amount = parseAmount(q);
    const from = parseTime(q.from, "from") ?? null;
    const to = parseTime(q.to, "to") ?? null;
    if (!text && amount === null) throw badRequest("give q (phone, email, reference, attempt or order id) or amount");
    const kind: LookupQueryKind = !text ? "none" : looksLikeEmail(text) ? "email" : looksLikePhone(text) ? "phone" : "ref";
    const salt = (project as ProjectRow & { salt?: string | null }).salt;
    const hashes: string[] = [];
    if (salt && kind === "email") hashes.push(await customerHash(salt, normaliseEmail(text)));
    if (salt && kind === "phone") hashes.push(await customerHash(salt, normalisePhone(text)));

    const where = ["p.project_id = ?1", "p.env = ?2"];
    const args: (string | number)[] = [project.id, envName];
    const arg = (v: string | number) => (args.push(v), `?${args.length}`);
    if (text) {
      const refs = [text, ...hashes].map(arg).join(", ");
      const t1 = arg(text);
      where.push(
        `(p.attempt_id = ${t1} OR p.order_id = ${t1}${hashes.length ? ` OR p.customer_hash IN (${hashes.map(arg).join(", ")})` : ""}
          OR p.attempt_id IN (SELECT attempt_id FROM payment_refs WHERE project_id = ?1 AND env = ?2 AND ref IN (${refs})))`,
      );
    }
    if (amount !== null) where.push(`p.amount_paisa = ${arg(amount)}`);
    if (from !== null) where.push(`p.started_at >= ${arg(from)}`);
    if (to !== null) where.push(`p.started_at < ${arg(to)}`);
    const refArgs = [project.id, envName, text, ...hashes];
    const [pays, refRows] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT p.* FROM payments p WHERE ${where.join(" AND ")} ORDER BY p.started_at DESC LIMIT 50`).bind(...args),
      c.env.DB.prepare(`SELECT attempt_id, kind FROM payment_refs WHERE project_id = ? AND env = ? AND ref IN (${refArgs.slice(2).map(() => "?").join(", ")})`).bind(...refArgs),
    ]);
    const rows = pays.results as PaymentRow[];
    const kinds = new Map<string, Set<string>>();
    for (const r of refRows.results as { attempt_id: string; kind: string }[]) {
      if (!kinds.has(r.attempt_id)) kinds.set(r.attempt_id, new Set());
      kinds.get(r.attempt_id)!.add(r.kind);
    }
    const dups = new Map<string, string>();
    if (rows.length) {
      const ids = rows.map((r) => r.attempt_id);
      const d = await c.env.DB.prepare(
        `SELECT attempt_id, related_attempt_id FROM refund_cases WHERE project_id = ? AND env = ? AND kind = 'duplicate' AND attempt_id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(project.id, envName, ...ids)
        .all<{ attempt_id: string; related_attempt_id: string }>();
      for (const r of d.results) dups.set(r.attempt_id, r.related_attempt_id);
    }
    const items: LookupMatch[] = rows.map((p) => {
      const by = new Set<LookupMatch["matched_by"][number]>();
      const k = kinds.get(p.attempt_id) ?? new Set();
      if (text && p.attempt_id === text) by.add("attempt");
      if (text && p.order_id === text) by.add("order");
      if (k.has("provider") || k.has("refund")) by.add("ref");
      if ((p.customer_hash && hashes.includes(p.customer_hash)) || k.has("customer")) by.add(kind === "email" ? "email" : "phone");
      if (amount !== null) by.add("amount");
      const v = verdictFor(p, dups.get(p.attempt_id) ?? null);
      return { payment: toSummary(p), verdict: v.verdict, text: v.text, fulfilled: p.fulfil_count > 0, matched_by: [...by], duplicate_of: dups.get(p.attempt_id) ?? null };
    });
    const result: LookupResult = { query: { q: text || null, kind, amount_paisa: amount, from, to }, items };
    return c.json(result);
  });

  api.post("/projects/:p/payments/:attempt/status-link", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const envName = envFrom(c, body);
    const attempt = c.req.param("attempt");
    const days = body.expires_days === undefined ? 7 : body.expires_days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) throw badRequest("expires_days must be an integer from 1 to 90");
    if (!(await paymentsByAttempt(c.env, project.id, envName, [attempt])).has(attempt)) throw notFound("payment");
    const token = randomToken();
    const t = now();
    const link: StatusLink = { url: `${appOrigin(c.env, c.req.raw)}/s/${token}`, expires_at: t + days * DAY };
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO status_links (token_hash, project_id, env, attempt_id, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        await sha256Hex(token), project.id, envName, attempt, t, link.expires_at, c.get("user").id,
      ),
      audit(c.env, project.org_id, c.get("user").id, "status_link.create", attempt, { env: envName, expires_days: days }),
    ]);
    return c.json(link, 201);
  });

  api.get("/projects/:p/payments/:attempt/ops", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = envFrom(c);
    const attempt = c.req.param("attempt");
    const [pay, cases] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT * FROM payments WHERE project_id = ? AND env = ? AND attempt_id = ?").bind(project.id, envName, attempt),
      c.env.DB.prepare("SELECT * FROM refund_cases WHERE project_id = ? AND env = ? AND (attempt_id = ?3 OR related_attempt_id = ?3) ORDER BY created_at DESC LIMIT 50").bind(project.id, envName, attempt),
    ]);
    const p = pay.results[0] as PaymentRow | undefined;
    if (!p) throw notFound("payment");
    const rows = cases.results as CaseRow[];
    const out: PaymentOps = {
      customer: p.customer_mask || p.customer_name ? { mask: p.customer_mask, name: p.customer_name } : null,
      refunded_paisa: p.refunded_paisa ?? 0,
      gw_env: (p.gw_env as PaymentOps["gw_env"]) ?? null,
      fulfilled_at: p.fulfilled_at,
      refund_cases: await casesWithPayments(c.env, project.id, envName, rows.filter((r) => r.attempt_id === attempt)),
      duplicate_of: rows.find((r) => r.kind === "duplicate" && r.attempt_id === attempt)?.related_attempt_id ?? null,
      duplicates: rows.filter((r) => r.kind === "duplicate" && r.related_attempt_id === attempt).map((r) => r.attempt_id),
    };
    return c.json(out);
  });

  // ---- Go-live doctor (4.4) ----

  api.get("/projects/:p/doctor", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = envFrom(c);
    const rows = (
      await c.env.DB.prepare("SELECT * FROM doctor_findings WHERE project_id = ? AND env = ? AND resolved_at IS NULL ORDER BY last_seen DESC LIMIT 200").bind(project.id, envName).all<FindingRow>()
    ).results.filter((r) => r.code in DOCTOR_CHECKS);
    const findings: DoctorFinding[] = rows
      .map((r) => {
        const info = DOCTOR_CHECKS[r.code];
        return {
          code: r.code, severity: info.severity, gateway: r.gateway || null, title: info.title, why: info.why, fix: info.fix, docs_url: info.docs_url,
          count: r.count, first_seen: r.first_seen, last_seen: r.last_seen, example_attempt: r.example_attempt, resolved_at: r.resolved_at,
        };
      })
      .sort((a, b) => (a.severity === b.severity ? b.last_seen - a.last_seen : a.severity === "critical" ? -1 : 1));
    const failing = new Set(findings.map((f) => f.code));
    const passed: DoctorCheck[] = DOCTOR_CODES.filter((code) => !failing.has(code)).map((code) => {
      const info = DOCTOR_CHECKS[code];
      const skip = info.live_only && envName !== "live";
      return { code, severity: info.severity, title: info.title, status: skip ? "not_checked" : "passed", line: skip ? "Checked on live traffic only." : info.passed };
    });
    const report: DoctorReport = {
      env: envName,
      critical: findings.filter((f) => f.severity === "critical").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      findings,
      passed,
    };
    return c.json(report);
  });

  api.post("/projects/:p/doctor/:code/resolve", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const code = c.req.param("code") as DoctorCode;
    if (!(DOCTOR_CODES as readonly string[]).includes(code)) throw notFound("doctor check");
    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const envName = envFrom(c, body);
    const gateway = str(body, "gateway", { max: 32 });
    const r = await c.env.DB.prepare(
      `UPDATE doctor_findings SET resolved_at = ? WHERE project_id = ? AND env = ? AND code = ? AND resolved_at IS NULL ${gateway ? "AND gateway = ?" : ""}`,
    )
      .bind(now(), project.id, envName, code, ...(gateway ? [gateway] : []))
      .run();
    if (!r.meta.changes) throw notFound("open finding");
    await audit(c.env, project.org_id, c.get("user").id, "doctor.resolve", code, { env: envName, gateway: gateway ?? null }).run();
    return c.json({ resolved: r.meta.changes });
  });
}
