// POST /v1/events (platform/SPEC.md sections 3 and 4).
//
// One D1 batch (a single transaction) per request holds, for every event:
//   1. a read of the payment row as it was before this event,
//   2. the payments upsert, skipped when the event id already exists (idempotency),
//   3. INSERT OR IGNORE into events.
// The upsert is written so the result does not depend on arrival order; see APPLY below.
// minute_stats are then updated from the status transitions the batch produced.
import { FINAL_STATUSES, KEY_PREFIX, MAX_BATCH_BYTES, MAX_BATCH_EVENTS, impliedStatus, validateEvent, type PaymentEvent } from "@paynp/shared";
import type { Context } from "hono";
import { onIngest, type IngestTransition } from "./alerts/engine.ts";
import { toEvent, toPayment } from "./lib/rows.ts";
import { MINUTE, errorBody, now as clock, sha256Hex } from "./lib/util.ts";
import type { AppEnv, EventRow, PaymentRow } from "./types.ts";

const F = `(${FINAL_STATUSES.map((s) => `'${s}'`).join(",")})`;

// The event's status (?7, at ts ?8) replaces the current one when
//   a) the payment is still open and the event carries a final status (a final outcome always lands, even if it is older), or
//   b) the event is not older than the current status and it would not turn a final status back into an open one.
// Applying (a) and (b) in any order gives the same result, so out-of-order batches converge.
const APPLY = `(?7 IS NOT NULL AND ((payments.status NOT IN ${F} AND ?7 IN ${F}) OR (?8 >= payments.status_at AND NOT (payments.status IN ${F} AND ?7 NOT IN ${F}))))`;
const HAS_REASON = `(?15 = 1 AND ?8 >= payments.reason_at)`;

const UPSERT_PAYMENT = `
INSERT INTO payments (project_id, env, attempt_id, order_id, gateway, amount_paisa, status, started_at, updated_at, finished_at,
  provider_ref, last_reason, last_message, event_count, error_count, fulfil_count, status_at, reason_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 'initiated'), ?8, ?8, CASE WHEN ?7 IN ${F} THEN ?8 END,
  ?9, ?10, ?11, 1, ?12, ?13, CASE WHEN ?7 IS NULL THEN 0 ELSE ?8 END, CASE WHEN ?15 = 1 THEN ?8 ELSE 0 END
WHERE NOT EXISTS (SELECT 1 FROM events WHERE project_id = ?1 AND env = ?2 AND id = ?14)
ON CONFLICT (project_id, env, attempt_id) DO UPDATE SET
  order_id = COALESCE(payments.order_id, excluded.order_id),
  amount_paisa = COALESCE(payments.amount_paisa, excluded.amount_paisa),
  status = CASE WHEN ${APPLY} THEN ?7 ELSE payments.status END,
  status_at = CASE WHEN ${APPLY} THEN ?8 ELSE payments.status_at END,
  finished_at = CASE
    WHEN ${APPLY} AND ?7 IN ${F} AND NOT (?7 = 'refunded' AND payments.finished_at IS NOT NULL) THEN ?8
    WHEN ${APPLY} AND ?7 NOT IN ${F} THEN NULL
    ELSE payments.finished_at END,
  started_at = MIN(payments.started_at, ?8),
  updated_at = MAX(payments.updated_at, ?8),
  provider_ref = COALESCE(?9, payments.provider_ref),
  last_reason = CASE WHEN ${HAS_REASON} THEN ?10 ELSE payments.last_reason END,
  last_message = CASE WHEN ${HAS_REASON} THEN ?11 ELSE payments.last_message END,
  reason_at = CASE WHEN ${HAS_REASON} THEN ?8 ELSE payments.reason_at END,
  event_count = payments.event_count + 1,
  error_count = payments.error_count + ?12,
  fulfil_count = payments.fulfil_count + ?13
RETURNING *`;

const INSERT_EVENT = `INSERT OR IGNORE INTO events (project_id, env, id, attempt_id, type, ts, received_at, gateway, status, duration_ms, data, order_id, amount_paisa, sdk)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

const UPSERT_STATS = `INSERT INTO minute_stats (project_id, env, gateway, minute, started, paid, failed, paid_amount_paisa, gw_requests, gw_errors, gw_ms_total, gw_ms_max)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
ON CONFLICT (project_id, env, gateway, minute) DO UPDATE SET
  started = started + excluded.started, paid = paid + excluded.paid, failed = failed + excluded.failed,
  paid_amount_paisa = paid_amount_paisa + excluded.paid_amount_paisa, gw_requests = gw_requests + excluded.gw_requests,
  gw_errors = gw_errors + excluded.gw_errors, gw_ms_total = gw_ms_total + excluded.gw_ms_total, gw_ms_max = MAX(gw_ms_max, excluded.gw_ms_max)`;

interface StatDelta {
  gateway: string;
  minute: number;
  started: number;
  paid: number;
  failed: number;
  paid_amount_paisa: number;
  gw_requests: number;
  gw_errors: number;
  gw_ms_total: number;
  gw_ms_max: number;
}

/** A gateway call counts as an error on a 5xx, a status of 0, or no HTTP status at all with a reason (network, timeout). */
export function isGatewayError(e: PaymentEvent): boolean {
  const s = e.data?.http_status;
  if (typeof s === "number") return s >= 500 || s === 0;
  return e.data?.reason !== undefined;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  transitions: IngestTransition[];
  /** Latest payment row per attempt after the batch. */
  payments: Map<string, PaymentRow>;
  stored: { event: EventRow; attempt_id: string }[];
}

/** Writes validated events for one project environment. Exported so tests and the synthetic trace can call it directly. */
export async function ingestEvents(env: Env, projectId: string, envName: string, events: PaymentEvent[], receivedAt = clock()): Promise<IngestResult> {
  // Process in client time order. The SQL does not depend on it; it only keeps minute_stats transitions intuitive.
  const sorted = events.map((e, i) => ({ e, i, ts: Date.parse(e.ts) })).sort((a, b) => a.ts - b.ts || a.i - b.i);
  const stmts: D1PreparedStatement[] = [];
  const rows: EventRow[] = [];
  for (const { e, ts } of sorted) {
    const status = impliedStatus(e) ?? null;
    const err = e.type === "error" || (e.type === "signature.checked" && e.data?.valid === false) ? 1 : 0;
    const ful = e.type === "payment.fulfilled" ? 1 : 0;
    const hasReason = e.data?.reason !== undefined || e.data?.message !== undefined ? 1 : 0;
    stmts.push(
      env.DB.prepare("SELECT status, fulfil_count, finished_at, gateway, amount_paisa FROM payments WHERE project_id = ? AND env = ? AND attempt_id = ?").bind(projectId, envName, e.attempt_id),
      env.DB.prepare(UPSERT_PAYMENT).bind(
        projectId, envName, e.attempt_id, e.order_id ?? null, e.gateway, e.amount_paisa ?? null, status, ts,
        e.data?.provider_ref ?? null, e.data?.reason ?? null, e.data?.message ?? null, err, ful, e.id, hasReason,
      ),
    );
    const row: EventRow = {
      project_id: projectId, env: envName, id: e.id, attempt_id: e.attempt_id, type: e.type, ts, received_at: receivedAt, gateway: e.gateway,
      status: e.status ?? null, duration_ms: e.duration_ms ?? null, data: e.data ? JSON.stringify(e.data) : null,
      order_id: e.order_id ?? null, amount_paisa: e.amount_paisa ?? null, sdk: e.sdk ? JSON.stringify(e.sdk) : null,
    };
    rows.push(row);
    stmts.push(
      env.DB.prepare(INSERT_EVENT).bind(row.project_id, row.env, row.id, row.attempt_id, row.type, row.ts, row.received_at, row.gateway, row.status, row.duration_ms, row.data, row.order_id, row.amount_paisa, row.sdk),
    );
  }
  const results = stmts.length ? await env.DB.batch(stmts) : [];

  const deltas = new Map<string, StatDelta>();
  const delta = (gateway: string, ts: number): StatDelta => {
    const minute = Math.floor(ts / MINUTE);
    const k = `${gateway}|${minute}`;
    let d = deltas.get(k);
    if (!d) deltas.set(k, (d = { gateway, minute, started: 0, paid: 0, failed: 0, paid_amount_paisa: 0, gw_requests: 0, gw_errors: 0, gw_ms_total: 0, gw_ms_max: 0 }));
    return d;
  };

  const out: IngestResult = { accepted: 0, duplicates: 0, transitions: [], payments: new Map(), stored: [] };
  sorted.forEach(({ e, ts }, n) => {
    const old = (results[n * 3].results[0] ?? null) as Pick<PaymentRow, "status" | "fulfil_count" | "finished_at" | "gateway" | "amount_paisa"> | null;
    const payment = results[n * 3 + 1].results[0] as PaymentRow | undefined;
    const inserted = (results[n * 3 + 2].meta.changes ?? 0) > 0;
    if (!inserted || !payment) {
      out.duplicates++;
      return;
    }
    out.accepted++;
    out.stored.push({ event: rows[n], attempt_id: e.attempt_id });
    out.payments.set(e.attempt_id, payment);
    out.transitions.push({ event: e, old, payment });

    if (e.type === "payment.started") delta(e.gateway, ts).started++;
    if (e.type === "gateway.request") {
      const d = delta(e.gateway, ts);
      d.gw_requests++;
      if (isGatewayError(e)) d.gw_errors++;
      d.gw_ms_total += e.duration_ms ?? 0;
      d.gw_ms_max = Math.max(d.gw_ms_max, e.duration_ms ?? 0);
    }
    // Paid and failed counts follow the payment's status, so a late or repeated status event never double counts.
    const was = old?.status;
    const is = payment.status;
    if (is === "paid" && was !== "paid") {
      const d = delta(payment.gateway, payment.finished_at ?? ts);
      d.paid++;
      d.paid_amount_paisa += payment.amount_paisa ?? 0;
    }
    if (is === "failed" && was !== "failed") delta(payment.gateway, payment.finished_at ?? ts).failed++;
    if (old && was === "paid" && is !== "paid") {
      const d = delta(old.gateway, old.finished_at ?? ts);
      d.paid--;
      d.paid_amount_paisa -= old.amount_paisa ?? 0;
    }
    if (old && was === "failed" && is !== "failed") delta(old.gateway, old.finished_at ?? ts).failed--;
  });

  const after: D1PreparedStatement[] = [];
  for (const d of deltas.values()) {
    after.push(env.DB.prepare(UPSERT_STATS).bind(projectId, envName, d.gateway, d.minute, d.started, d.paid, d.failed, d.paid_amount_paisa, d.gw_requests, d.gw_errors, d.gw_ms_total, d.gw_ms_max));
  }
  if (after.length) await env.DB.batch(after);
  return out;
}

const KEY_RE = /^pnp_(test|live)_[0-9A-Za-z]{32}$/;

async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleIngest(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const auth = c.req.header("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const m = KEY_RE.exec(key);
  if (!m) return c.json(errorBody("unauthorized", `expected Authorization: Bearer ${KEY_PREFIX.test}...`), 401);
  const row = await env.DB.prepare("SELECT id, project_id, env, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(key))
    .first<{ id: string; project_id: string; env: string; last_used_at: number | null }>();
  if (!row || row.env !== m[1]) return c.json(errorBody("unauthorized", "unknown or revoked key"), 401);

  const { success } = await env.INGEST_LIMITER.limit({ key: row.id });
  if (!success) {
    c.header("Retry-After", "1");
    return c.json(errorBody("rate_limited", "too many requests for this key"), 429);
  }

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BATCH_BYTES) return c.json(errorBody("too_large", `body over ${MAX_BATCH_BYTES} bytes`), 413);
  const text = await readCapped(c.req.raw, MAX_BATCH_BYTES);
  if (text === null) return c.json(errorBody("too_large", `body over ${MAX_BATCH_BYTES} bytes`), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json(errorBody("bad_request", "body must be JSON"), 400);
  }
  const list = (body as { events?: unknown })?.events;
  if (!Array.isArray(list)) return c.json(errorBody("bad_request", "body must be {\"events\": [...]}"), 400);
  // INGEST_MAX_EVENTS lowers the cap on the Workers free plan, where D1 allows 50 queries per invocation.
  const maxEvents = Math.min(MAX_BATCH_EVENTS, Number(c.env.INGEST_MAX_EVENTS) || MAX_BATCH_EVENTS);
  if (list.length > maxEvents) return c.json(errorBody("too_large", `at most ${maxEvents} events per batch`), 413);

  const valid: PaymentEvent[] = [];
  const errors: { index: number; id?: string; error: string }[] = [];
  list.forEach((raw, index) => {
    const r = validateEvent(raw);
    if (r.ok) valid.push(r.event);
    else errors.push({ index, id: typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : undefined, error: r.error });
  });

  const t = clock();
  const result = await ingestEvents(env, row.project_id, row.env, valid, t);
  if (row.last_used_at === null || t - row.last_used_at > MINUTE) {
    c.executionCtx.waitUntil(env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(t, row.id).run());
  }
  if (result.accepted) c.executionCtx.waitUntil(afterIngest(env, row.project_id, row.env, result, t));

  const payload = { accepted: result.accepted, duplicates: result.duplicates };
  if (errors.length) return c.json({ ...payload, errors, error: { code: "invalid_events", message: `${errors.length} invalid event(s)` } }, 400);
  return c.json(payload, 202);
}

/** Live broadcast and per-event alert rules. Runs after the response. */
export async function afterIngest(env: Env, projectId: string, envName: string, result: IngestResult, t: number): Promise<void> {
  const items = result.stored.map(({ event, attempt_id }) => ({ event: toEvent(event), payment: toPayment(result.payments.get(attempt_id)!) }));
  const tasks: Promise<unknown>[] = [
    env.LIVE.getByName(`${projectId}:${envName}`)
      .publish(projectId, envName, items)
      .catch((e: unknown) => console.error(JSON.stringify({ msg: "live publish failed", error: String(e) }))),
    onIngest(env, projectId, envName, result.transitions, t).catch((e: unknown) => console.error(JSON.stringify({ msg: "alert evaluation failed", error: String(e) }))),
  ];
  await Promise.all(tasks);
}
