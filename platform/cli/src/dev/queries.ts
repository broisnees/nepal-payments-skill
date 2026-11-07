// The read side of /api for `paynp dev`: the queries in worker/src/api/data.ts over DevStore, with the same
// filters, ordering, cursors and response shapes.
import type { Analytics, Env as PayEnv, GatewayHealth, Payment, PaymentDetail, SeriesPoint, StoredEvent } from "../../../shared/src/api.ts";
import type { PaymentStatus } from "../../../shared/src/events.ts";
import { explain } from "../../../shared/src/explain.ts";
import { MINUTE, type DevStore, type EventRow, type PaymentRow } from "./store.ts";

export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Buckets line up with the Asia/Kathmandu clock (UTC+05:45), like the worker. */
export const NPT_OFFSET = (5 * 60 + 45) * MINUTE;
export const HEALTH_WINDOW_MIN = 15;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);

export function toPayment(r: PaymentRow): Payment {
  return {
    attempt_id: r.attempt_id, env: r.env as PayEnv, order_id: r.order_id, gateway: r.gateway, amount_paisa: r.amount_paisa, currency: r.currency,
    status: r.status as PaymentStatus, started_at: r.started_at, updated_at: r.updated_at, finished_at: r.finished_at,
    provider_ref: r.provider_ref, last_reason: r.last_reason, last_message: r.last_message,
    event_count: r.event_count, error_count: r.error_count, fulfil_count: r.fulfil_count,
  };
}

const parseJson = <T>(s: string | null, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function toEvent(r: EventRow): StoredEvent {
  const e: StoredEvent = { id: r.id, type: r.type as StoredEvent["type"], ts: new Date(r.ts).toISOString(), attempt_id: r.attempt_id, gateway: r.gateway, received_at: r.received_at };
  if (r.order_id != null) e.order_id = r.order_id;
  if (r.amount_paisa != null) e.amount_paisa = r.amount_paisa;
  if (r.status != null) e.status = r.status as PaymentStatus;
  if (r.duration_ms != null) e.duration_ms = r.duration_ms;
  const data = parseJson<StoredEvent["data"] | null>(r.data, null);
  if (data) e.data = data;
  const sdk = parseJson<StoredEvent["sdk"] | null>(r.sdk, null);
  if (sdk) e.sdk = sdk;
  return e;
}

// ------------------------------------------------------------------ query parsing (worker/src/lib/util.ts)
export function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}
export function decodeCursor(cursor: string | null): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v;
  } catch {
    // fall through
  }
  throw badRequest("invalid cursor");
}
export function parseLimit(raw: string | null, def = 50, max = 200): number {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer");
  return Math.min(n, max);
}
export function parseTime(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be epoch ms or an ISO 8601 time`);
  return n;
}
export function parseEnv(raw: string | null): "test" | "live" {
  if (raw === null || raw === "" || raw === "test") return "test";
  if (raw === "live") return "live";
  throw badRequest("env must be test or live");
}
function page<T>(rows: T[], limit: number, key: (row: T) => (string | number)[]) {
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? encodeCursor(key(items[items.length - 1])) : null };
}
/** SQLite row-value comparison (a, b) < (c, d). */
const tupleLess = (a: number, b: string, c: string | number, d: string | number) => a < (c as number) || (a === c && b < (d as string));
const byDesc = (a: [number, string], b: [number, string]) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);

// ------------------------------------------------------------------ endpoints
export function listPayments(store: DevStore, q: URLSearchParams) {
  const env = parseEnv(q.get("env"));
  const limit = parseLimit(q.get("limit"));
  const cur = decodeCursor(q.get("cursor"));
  const statuses = q.get("status")?.split(",").filter(Boolean);
  const gateway = q.get("gateway");
  const term = q.get("q")?.trim();
  const from = parseTime(q.get("from"), "from");
  const to = parseTime(q.get("to"), "to");
  const bounds: [number | undefined, (n: number, b: number) => boolean][] = [];
  for (const [k, cmp] of [["min", (n: number, b: number) => n >= b], ["max", (n: number, b: number) => n <= b]] as const) {
    const raw = q.get(k);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest(`${k} must be a number of paisa`);
    bounds.push([n, cmp]);
  }
  const rows = store
    .paymentsOf(env)
    .filter((p) => {
      if (statuses?.length && !statuses.includes(p.status)) return false;
      if (gateway && p.gateway !== gateway) return false;
      if (term && ![p.attempt_id, p.order_id, p.provider_ref].some((v) => v != null && v.toLowerCase().startsWith(term.toLowerCase()))) return false;
      if (from !== undefined && p.started_at < from) return false;
      if (to !== undefined && p.started_at >= to) return false;
      // SQL: NULL amount never matches a bound.
      for (const [b, cmp] of bounds) if (p.amount_paisa === null || !cmp(p.amount_paisa, b!)) return false;
      if (cur && !tupleLess(p.started_at, p.attempt_id, cur[0], cur[1])) return false;
      return true;
    })
    .sort((a, b) => byDesc([a.started_at, a.attempt_id], [b.started_at, b.attempt_id]))
    .slice(0, limit + 1);
  const p = page(rows, limit, (r) => [r.started_at, r.attempt_id]);
  return { items: p.items.map(toPayment), next_cursor: p.next_cursor };
}

export function paymentDetail(store: DevStore, attempt: string, q: URLSearchParams): PaymentDetail {
  const env = parseEnv(q.get("env"));
  const row = store.payments.get(`${env}|${attempt}`);
  if (!row) throw notFound("payment");
  const events = store
    .eventsOf(env)
    .filter((e) => e.attempt_id === attempt)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 1000)
    .map(toEvent);
  let ex: PaymentDetail["explain"] = null;
  if (row.status !== "paid" || row.error_count > 0) {
    // Newest first: gateway codes (most specific), then reasons and provider statuses, then the payment's last reason.
    const newest = events.map((e) => e.data).filter((d) => d !== undefined).reverse();
    for (const d of newest) ex ??= explain({ gateway: row.gateway, provider_code: d.provider_code ?? (d.http_status && d.http_status >= 400 ? String(d.http_status) : null) });
    for (const d of newest) ex ??= explain({ gateway: row.gateway, reason: d.reason, provider_status: d.provider_status });
    ex ??= explain({ gateway: row.gateway, reason: row.last_reason });
  }
  return { payment: toPayment(row), events, explain: ex };
}

export function listEvents(store: DevStore, q: URLSearchParams) {
  const env = parseEnv(q.get("env"));
  const limit = parseLimit(q.get("limit"), 100, 500);
  const cur = decodeCursor(q.get("cursor"));
  const type = q.get("type");
  const gateway = q.get("gateway");
  const since = parseTime(q.get("since"), "since");
  const rows = store
    .eventsOf(env)
    .filter((e) => (!type || e.type === type) && (!gateway || e.gateway === gateway) && (since === undefined || e.ts >= since) && (!cur || tupleLess(e.ts, e.id, cur[0], cur[1])))
    .sort((a, b) => byDesc([a.ts, a.id], [b.ts, b.id]))
    .slice(0, limit + 1);
  const p = page(rows, limit, (r) => [r.ts, r.id]);
  return { items: p.items.map(toEvent), next_cursor: p.next_cursor };
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null);
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

interface Sum {
  started: number;
  paid: number;
  failed: number;
  revenue: number;
  byCurrency: Record<string, number>;
  req: number;
  err: number;
  ms: number;
}
const emptySum = (): Sum => ({ started: 0, paid: 0, failed: 0, revenue: 0, byCurrency: {}, req: 0, err: 0, ms: 0 });

export function analytics(store: DevStore, q: URLSearchParams, t = Date.now()): Analytics {
  const env = parseEnv(q.get("env"));
  const to = parseTime(q.get("to"), "to") ?? t;
  const from = parseTime(q.get("from"), "from") ?? to - 7 * DAY;
  if (from >= to) throw badRequest("from must be before to");
  const bucket = q.get("bucket") ?? "hour";
  if (bucket !== "hour" && bucket !== "day") throw badRequest("bucket must be hour or day");
  const size = bucket === "hour" ? HOUR : DAY;
  const first = Math.floor((from + NPT_OFFSET) / size);
  const last = Math.floor((to - 1 + NPT_OFFSET) / size);
  if (last - first > 2000) throw badRequest("too many buckets; use a shorter range or bucket=day");
  const gateway = q.get("gateway");
  const lo = Math.floor(from / MINUTE);
  const hi = Math.ceil(to / MINUTE);

  const total = emptySum();
  const byBucket = new Map<number, Sum>();
  const byGw = new Map<string, Sum>();
  for (const m of store.minutesOf(env)) {
    if (m.minute < lo || m.minute >= hi || (gateway && m.gateway !== gateway)) continue;
    const b = Math.floor((m.minute * MINUTE + NPT_OFFSET) / size);
    if (!byBucket.has(b)) byBucket.set(b, emptySum());
    if (!byGw.has(m.gateway)) byGw.set(m.gateway, emptySum());
    for (const s of [total, byBucket.get(b)!, byGw.get(m.gateway)!]) {
      s.started += m.started;
      s.paid += m.paid;
      s.failed += m.failed;
      if (m.currency === "NPR") s.revenue += m.paid_amount_paisa;
      if (m.paid_amount_paisa) s.byCurrency[m.currency] = (s.byCurrency[m.currency] ?? 0) + m.paid_amount_paisa;
      s.req += m.gw_requests;
      s.err += m.gw_errors;
      s.ms += m.gw_ms_total;
    }
  }
  const point = (tStart: number, r: Sum | undefined): SeriesPoint => {
    const paid = r?.paid ?? 0;
    const failed = r?.failed ?? 0;
    return {
      t: tStart, started: r?.started ?? 0, paid, failed, revenue_paisa: r?.revenue ?? 0, revenue_by_currency: Object.fromEntries(Object.entries(r?.byCurrency ?? {}).filter(([, n]) => n !== 0)),
      success_rate: rate(paid, paid + failed), gw_latency_avg: rate(r?.ms ?? 0, r?.req ?? 0), gw_error_rate: rate(r?.err ?? 0, r?.req ?? 0),
    };
  };
  const series: SeriesPoint[] = [];
  for (let b = first; b <= last; b++) series.push(point(b * size - NPT_OFFSET, byBucket.get(b)));
  const tp = point(from, total);

  const pays = store.paymentsOf(env).filter((p) => p.started_at >= from && p.started_at < to && (!gateway || p.gateway === gateway));
  const reasons = new Map<string, number>();
  for (const p of pays) if (p.status === "failed") reasons.set(p.last_reason ?? "unknown", (reasons.get(p.last_reason ?? "unknown") ?? 0) + 1);
  const durations = pays
    .filter((p) => p.status === "paid" && p.finished_at !== null)
    .map((p) => p.finished_at! - p.started_at)
    .sort((a, b) => a - b)
    .slice(0, 20000);
  const types = new Map<string, Set<string>>();
  for (const e of store.eventsOf(env)) {
    if (e.type !== "payment.redirected" && e.type !== "callback.received") continue;
    if (!types.has(e.type)) types.set(e.type, new Set());
    types.get(e.type)!.add(e.attempt_id);
  }
  const has = (type: string, a: string) => types.get(type)?.has(a) ?? false;

  return {
    series,
    totals: { started: tp.started, paid: tp.paid, failed: tp.failed, revenue_paisa: tp.revenue_paisa, revenue_by_currency: tp.revenue_by_currency, success_rate: tp.success_rate },
    by_gateway: [...byGw.entries()]
      .sort((a, b) => b[1].started - a[1].started)
      .map(([gw, r]) => {
        const p = point(from, r);
        return { gateway: gw, started: p.started, paid: p.paid, failed: p.failed, revenue_paisa: p.revenue_paisa, revenue_by_currency: p.revenue_by_currency, success_rate: p.success_rate };
      }),
    failure_reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    time_to_pay_ms: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
    funnel: {
      started: pays.length,
      redirected: pays.filter((p) => has("payment.redirected", p.attempt_id)).length,
      callback: pays.filter((p) => has("callback.received", p.attempt_id)).length,
      paid: pays.filter((p) => p.status === "paid").length,
    },
  };
}

/** Per-gateway state over the last 15 minutes, for every gateway seen in the last 7 days. Same rules as the worker. */
export function gatewayHealth(store: DevStore, env: string, t = Date.now()): GatewayHealth[] {
  const nowMin = Math.floor(t / MINUTE);
  const recent = nowMin - HEALTH_WINDOW_MIN;
  const agg = new Map<string, { req: number; err: number; ms: number; mx: number }>();
  for (const m of store.minutesOf(env)) {
    if (m.minute <= nowMin - 7 * 1440) continue;
    const a = agg.get(m.gateway) ?? { req: 0, err: 0, ms: 0, mx: 0 };
    agg.set(m.gateway, a);
    if (m.minute > recent) {
      a.req += m.gw_requests;
      a.err += m.gw_errors;
      a.ms += m.gw_ms_total;
      a.mx = Math.max(a.mx, m.gw_ms_max);
    }
  }
  return [...agg.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([gateway, r]) => {
      const error_rate = rate(r.err, r.req);
      const latency_avg = rate(r.ms, r.req);
      let state: GatewayHealth["state"] = "ok";
      if (!r.req) state = "idle";
      else if (r.req >= 3 && (error_rate ?? 0) >= 0.5) state = "down";
      else if ((error_rate ?? 0) >= 0.1 || (latency_avg ?? 0) > 5000) state = "degraded";
      return { gateway, requests: r.req, error_rate, latency_avg, latency_max: r.req ? r.mx : null, state };
    });
}
