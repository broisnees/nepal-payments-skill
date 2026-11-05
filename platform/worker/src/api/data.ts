// Payments, events, analytics, health and the live stream.
import { explain, type Analytics, type GatewayHealth, type PaymentDetail, type SeriesPoint } from "@paynp/shared";
import type { Hono } from "hono";
import { requireProject } from "../lib/access.ts";
import { toEvent, toPayment } from "../lib/rows.ts";
import { DAY, HOUR, MINUTE, badRequest, decodeCursor, likePrefix, notFound, now, page, parseEnv, parseLimit, parseTime } from "../lib/util.ts";
import type { AppEnv, EventRow, PaymentRow } from "../types.ts";

/** Buckets line up with the Asia/Kathmandu clock (UTC+05:45), so "day" means a Nepali calendar day. */
export const NPT_OFFSET = (5 * 60 + 45) * MINUTE;

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function registerData(api: Hono<AppEnv>) {
  api.get("/projects/:p/payments", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = parseEnv(q.env);
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    const where = ["project_id = ?", "env = ?"];
    const args: (string | number)[] = [project.id, envName];
    if (q.status) {
      const list = q.status.split(",").filter(Boolean);
      where.push(`status IN (${list.map(() => "?").join(",")})`);
      args.push(...list);
    }
    if (q.gateway) {
      where.push("gateway = ?");
      args.push(q.gateway);
    }
    if (q.q) {
      const like = likePrefix(q.q.trim());
      where.push("(attempt_id LIKE ? ESCAPE '\\' OR order_id LIKE ? ESCAPE '\\' OR provider_ref LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const from = parseTime(q.from, "from");
    const to = parseTime(q.to, "to");
    if (from !== undefined) where.push("started_at >= ?"), args.push(from);
    if (to !== undefined) where.push("started_at < ?"), args.push(to);
    for (const [k, op] of [["min", ">="], ["max", "<="]] as const) {
      if (q[k] === undefined || q[k] === "") continue;
      const n = Number(q[k]);
      if (!Number.isFinite(n)) throw badRequest(`${k} must be a number of paisa`);
      where.push(`amount_paisa ${op} ?`);
      args.push(n);
    }
    if (cur) where.push("(started_at, attempt_id) < (?, ?)"), args.push(...cur);
    const rows = await c.env.DB.prepare(`SELECT * FROM payments WHERE ${where.join(" AND ")} ORDER BY started_at DESC, attempt_id DESC LIMIT ?`)
      .bind(...args, limit + 1)
      .all<PaymentRow>();
    const p = page(rows.results, limit, (r) => [r.started_at, r.attempt_id]);
    return c.json({ items: p.items.map(toPayment), next_cursor: p.next_cursor });
  });

  api.get("/projects/:p/payments/:attempt", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const attempt = c.req.param("attempt");
    const [pay, evs] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT * FROM payments WHERE project_id = ? AND env = ? AND attempt_id = ?").bind(project.id, envName, attempt),
      c.env.DB.prepare("SELECT * FROM events WHERE project_id = ? AND env = ? AND attempt_id = ? ORDER BY ts, id LIMIT 1000").bind(project.id, envName, attempt),
    ]);
    const row = pay.results[0] as PaymentRow | undefined;
    if (!row) throw notFound("payment");
    const events = (evs.results as EventRow[]).map(toEvent);
    let ex: PaymentDetail["explain"] = null;
    if (row.status !== "paid" || row.error_count > 0) {
      // Newest first: gateway codes (most specific), then reasons and provider statuses, then the payment's last reason.
      const newest = events.map((e) => e.data).filter((d) => d !== undefined).reverse();
      for (const d of newest) {
        ex ??= explain({ gateway: row.gateway, provider_code: d.provider_code ?? (d.http_status && d.http_status >= 400 ? String(d.http_status) : null) });
      }
      for (const d of newest) ex ??= explain({ gateway: row.gateway, reason: d.reason, provider_status: d.provider_status });
      ex ??= explain({ gateway: row.gateway, reason: row.last_reason });
    }
    const detail: PaymentDetail = { payment: toPayment(row), events, explain: ex };
    return c.json(detail);
  });

  api.get("/projects/:p/events", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = parseEnv(q.env);
    const limit = parseLimit(q.limit, 100, 500);
    const cur = decodeCursor(q.cursor);
    const where = ["project_id = ?", "env = ?"];
    const args: (string | number)[] = [project.id, envName];
    if (q.type) where.push("type = ?"), args.push(q.type);
    if (q.gateway) where.push("gateway = ?"), args.push(q.gateway);
    const since = parseTime(q.since, "since");
    if (since !== undefined) where.push("ts >= ?"), args.push(since);
    if (cur) where.push("(ts, id) < (?, ?)"), args.push(...cur);
    const rows = await c.env.DB.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`)
      .bind(...args, limit + 1)
      .all<EventRow>();
    const p = page(rows.results, limit, (r) => [r.ts, r.id]);
    return c.json({ items: p.items.map(toEvent), next_cursor: p.next_cursor });
  });

  api.get("/projects/:p/analytics", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = parseEnv(q.env);
    const t = now();
    const to = parseTime(q.to, "to") ?? t;
    const from = parseTime(q.from, "from") ?? to - 7 * DAY;
    if (from >= to) throw badRequest("from must be before to");
    const bucket = q.bucket ?? "hour";
    if (bucket !== "hour" && bucket !== "day") throw badRequest("bucket must be hour or day");
    const size = bucket === "hour" ? HOUR : DAY;
    const first = Math.floor((from + NPT_OFFSET) / size);
    const last = Math.floor((to - 1 + NPT_OFFSET) / size);
    if (last - first > 2000) throw badRequest("too many buckets; use a shorter range or bucket=day");
    const gw = q.gateway ? " AND gateway = ?" : "";
    const base = [project.id, envName, Math.floor(from / MINUTE), Math.ceil(to / MINUTE), ...(q.gateway ? [q.gateway] : [])];
    const pBase = [project.id, envName, from, to, ...(q.gateway ? [q.gateway] : [])];
    const sums = "SUM(started) AS started, SUM(paid) AS paid, SUM(failed) AS failed, SUM(paid_amount_paisa) AS revenue, SUM(gw_requests) AS req, SUM(gw_errors) AS err, SUM(gw_ms_total) AS ms";
    const ms = `FROM minute_stats WHERE project_id = ? AND env = ? AND minute >= ? AND minute < ?${gw}`;
    const ps = `FROM payments WHERE project_id = ? AND env = ? AND started_at >= ? AND started_at < ?${gw}`;
    type Sum = { started: number | null; paid: number | null; failed: number | null; revenue: number | null; req: number | null; err: number | null; ms: number | null };
    const [series, totals, byGw, reasons, ttp, funnel] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT (minute * 60000 + ${NPT_OFFSET}) / ${size} AS b, ${sums} ${ms} GROUP BY b`).bind(...base),
      c.env.DB.prepare(`SELECT ${sums} ${ms}`).bind(...base),
      c.env.DB.prepare(`SELECT gateway, ${sums} ${ms} GROUP BY gateway ORDER BY started DESC`).bind(...base),
      c.env.DB.prepare(`SELECT COALESCE(last_reason, 'unknown') AS reason, COUNT(*) AS count ${ps} AND status = 'failed' GROUP BY reason ORDER BY count DESC LIMIT 10`).bind(...pBase),
      c.env.DB.prepare(`SELECT finished_at - started_at AS d ${ps} AND status = 'paid' AND finished_at IS NOT NULL ORDER BY d LIMIT 20000`).bind(...pBase),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS started,
          SUM(EXISTS (SELECT 1 FROM events e WHERE e.project_id = payments.project_id AND e.env = payments.env AND e.attempt_id = payments.attempt_id AND e.type = 'payment.redirected')) AS redirected,
          SUM(EXISTS (SELECT 1 FROM events e WHERE e.project_id = payments.project_id AND e.env = payments.env AND e.attempt_id = payments.attempt_id AND e.type = 'callback.received')) AS callback,
          SUM(status = 'paid') AS paid ${ps}`,
      ).bind(...pBase),
    ]);
    const byBucket = new Map((series.results as (Sum & { b: number })[]).map((r) => [r.b, r]));
    const point = (tStart: number, r: Sum | undefined): SeriesPoint => {
      const paid = r?.paid ?? 0;
      const failed = r?.failed ?? 0;
      return {
        t: tStart,
        started: r?.started ?? 0,
        paid,
        failed,
        revenue_paisa: r?.revenue ?? 0,
        success_rate: rate(paid, paid + failed),
        gw_latency_avg: rate(r?.ms ?? 0, r?.req ?? 0),
        gw_error_rate: rate(r?.err ?? 0, r?.req ?? 0),
      };
    };
    const out: SeriesPoint[] = [];
    for (let b = first; b <= last; b++) out.push(point(b * size - NPT_OFFSET, byBucket.get(b)));
    const tot = totals.results[0] as Sum | undefined;
    const tp = point(from, tot);
    const durations = (ttp.results as { d: number }[]).map((r) => r.d);
    const f = (funnel.results[0] ?? {}) as Record<string, number | null>;
    const analytics: Analytics = {
      series: out,
      totals: { started: tp.started, paid: tp.paid, failed: tp.failed, revenue_paisa: tp.revenue_paisa, success_rate: tp.success_rate },
      by_gateway: (byGw.results as (Sum & { gateway: string })[]).map((r) => {
        const p = point(from, r);
        return { gateway: r.gateway, started: p.started, paid: p.paid, failed: p.failed, revenue_paisa: p.revenue_paisa, success_rate: p.success_rate };
      }),
      failure_reasons: reasons.results as { reason: string; count: number }[],
      time_to_pay_ms: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
      funnel: { started: f.started ?? 0, redirected: f.redirected ?? 0, callback: f.callback ?? 0, paid: f.paid ?? 0 },
    };
    return c.json(analytics);
  });

  api.get("/projects/:p/health", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const rows = await gatewayHealth(c.env, project.id, envName, now());
    return c.json({ items: rows, next_cursor: null });
  });

  api.get("/projects/:p/live", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw badRequest("expected a WebSocket upgrade", "upgrade_required");
    const url = `https://live.internal/connect?project=${encodeURIComponent(project.id)}&env=${envName}`;
    return c.env.LIVE.getByName(`${project.id}:${envName}`).fetch(new Request(url, c.req.raw));
  });
}

export const HEALTH_WINDOW_MIN = 15;

/** Per-gateway state over the last 15 minutes, for every gateway seen in the last 7 days. */
export async function gatewayHealth(env: Env, projectId: string, envName: string, t: number): Promise<GatewayHealth[]> {
  const nowMin = Math.floor(t / MINUTE);
  const rows = await env.DB.prepare(
    `SELECT gateway,
       SUM(CASE WHEN minute > ?3 THEN gw_requests ELSE 0 END) AS req,
       SUM(CASE WHEN minute > ?3 THEN gw_errors ELSE 0 END) AS err,
       SUM(CASE WHEN minute > ?3 THEN gw_ms_total ELSE 0 END) AS ms,
       MAX(CASE WHEN minute > ?3 THEN gw_ms_max ELSE 0 END) AS mx
     FROM minute_stats WHERE project_id = ?1 AND env = ?2 AND minute > ?4 GROUP BY gateway ORDER BY gateway`,
  )
    .bind(projectId, envName, nowMin - HEALTH_WINDOW_MIN, nowMin - 7 * 1440)
    .all<{ gateway: string; req: number; err: number; ms: number; mx: number }>();
  return rows.results.map((r) => {
    const error_rate = rate(r.err, r.req);
    const latency_avg = rate(r.ms, r.req);
    let state: GatewayHealth["state"] = "ok";
    if (!r.req) state = "idle";
    else if (r.req >= 3 && (error_rate ?? 0) >= 0.5) state = "down";
    else if ((error_rate ?? 0) >= 0.1 || (latency_avg ?? 0) > 5000) state = "degraded";
    return { gateway: r.gateway, requests: r.req, error_rate, latency_avg, latency_max: r.req ? r.mx : null, state };
  });
}
