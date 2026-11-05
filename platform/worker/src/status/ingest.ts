// status_minutes on ingest (SPEC-v2 4.6): live gateway.request events, aggregated per gateway and minute in memory and
// written as one statement per batch (json_each), so the free-plan D1 budget grows by at most 1 query per request.
// It runs in the same D1 batch as, and after, the minute_stats upsert: a project counts once per gateway-minute,
// the first time it sends a request for it (its minute_stats gw_requests equals this batch's count).
import type { PaymentEvent } from "@paynp/shared";
import { isGatewayError } from "../ingest.ts";
import { MINUTE } from "../lib/util.ts";
import { BUCKETS, H_COLS, bucketOf, emptyHist, p95, p95UpsertSql } from "./buckets.ts";

interface Agg {
  gateway: string;
  minute: number;
  requests: number;
  errors: number;
  ms_total: number;
  samples: number;
  ms_max: number;
  hist: number[];
}

/** Per gateway and minute, from accepted events. Exported for tests. */
export function aggregateStatus(events: readonly PaymentEvent[]): Agg[] {
  const m = new Map<string, Agg>();
  for (const e of events) {
    if (e.type !== "gateway.request") continue;
    const minute = Math.floor(Date.parse(e.ts) / MINUTE);
    const k = `${e.gateway}|${minute}`;
    let a = m.get(k);
    if (!a) m.set(k, (a = { gateway: e.gateway, minute, requests: 0, errors: 0, ms_total: 0, samples: 0, ms_max: 0, hist: emptyHist() }));
    a.requests++;
    if (isGatewayError(e)) a.errors++;
    if (typeof e.duration_ms === "number" && e.duration_ms >= 0) {
      a.samples++;
      a.ms_total += e.duration_ms;
      a.ms_max = Math.max(a.ms_max, e.duration_ms);
      a.hist[bucketOf(e.duration_ms)]++;
    }
  }
  return [...m.values()];
}

const j = (i: number) => `json_extract(j.value, '$[${i}]')`;
const H = H_COLS.join(", ");
const UPSERT = `INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total, ms_p95, samples, ms_max, ${H})
SELECT ${j(0)}, ${j(1)},
  CASE WHEN COALESCE((SELECT gw_requests FROM minute_stats m WHERE m.project_id = ?1 AND m.env = 'live' AND m.gateway = ${j(0)} AND m.minute = ${j(1)}), 0) > ${j(2)} THEN 0 ELSE 1 END,
  ${Array.from({ length: 6 + BUCKETS }, (_, i) => j(i + 2)).join(", ")}
FROM json_each(?2) j WHERE true
ON CONFLICT (gateway, minute) DO UPDATE SET
  projects = projects + excluded.projects, requests = requests + excluded.requests, errors = errors + excluded.errors,
  ms_total = ms_total + excluded.ms_total, ms_p95 = ${p95UpsertSql()}, samples = samples + excluded.samples,
  ms_max = MAX(ms_max, excluded.ms_max), ${H_COLS.map((h) => `${h} = ${h} + excluded.${h}`).join(", ")}`;

/** Zero or one statement to append to ingest's minute_stats batch (after the minute_stats upserts). */
export function statusMinuteStatements(env: Env, projectId: string, envName: string, transitions: readonly { event: PaymentEvent }[]): D1PreparedStatement[] {
  if (envName !== "live") return [];
  const aggs = aggregateStatus(transitions.map((t) => t.event));
  if (!aggs.length) return [];
  const payload = aggs.map((a) => [a.gateway, a.minute, a.requests, a.errors, a.ms_total, p95(a.hist, a.ms_max), a.samples, a.ms_max, ...a.hist]);
  return [env.DB.prepare(UPSERT).bind(projectId, JSON.stringify(payload))];
}
