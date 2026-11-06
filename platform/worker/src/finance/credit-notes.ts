// Credit notes (SPEC-v2 4.7): every refund gets a number CN-YYYYMM-#### once, in the order discerns first sees it, so
// exports for VAT stay stable after the events behind them expire (events are kept 30 days).
// Sources: payment.refunded events, and refund cases marked refunded by hand (gateways with no refund API) when no
// payment.refunded event exists for that payment. One INSERT ... SELECT per source; numbering uses ROW_NUMBER over
// the new refunds on top of the month's highest number, so a single statement numbers a whole batch.
import { NEPAL_OFFSET_MS } from "@paynp/shared";

const MONTH = (ts: string) => `strftime('%Y%m', (${ts} + ${NEPAL_OFFSET_MS}) / 1000, 'unixepoch')`;
const NEXT_SEQ = `COALESCE((SELECT MAX(c.seq) FROM credit_notes c WHERE c.project_id = n.project_id AND c.env = n.env AND c.month = n.month), 0)
    + ROW_NUMBER() OVER (PARTITION BY n.project_id, n.env, n.month ORDER BY n.ts, n.refund_key)`;
const COLS = "project_id, env, refund_key, attempt_id, gateway, month, seq, refunded_at, amount_paisa, reason, refund_ref, created_at";

const fromEvents = (scope: string) => `INSERT OR IGNORE INTO credit_notes (${COLS})
SELECT n.project_id, n.env, n.refund_key, n.attempt_id, n.gateway, n.month, ${NEXT_SEQ}, n.ts, n.amount_paisa, n.reason, n.refund_ref, ?1
FROM (
  SELECT e.project_id, e.env, e.id AS refund_key, e.attempt_id, e.gateway, e.ts, COALESCE(e.amount_paisa, p.amount_paisa) AS amount_paisa,
    json_extract(e.data, '$.refund_reason') AS reason, json_extract(e.data, '$.refund_ref') AS refund_ref, ${MONTH("e.ts")} AS month
  FROM events e LEFT JOIN payments p ON p.project_id = e.project_id AND p.env = e.env AND p.attempt_id = e.attempt_id
  WHERE e.type = 'payment.refunded' AND ${scope}
    AND NOT EXISTS (SELECT 1 FROM credit_notes c WHERE c.project_id = e.project_id AND c.env = e.env AND c.refund_key = e.id)
    AND NOT EXISTS (SELECT 1 FROM credit_notes c WHERE c.project_id = e.project_id AND c.env = e.env AND c.attempt_id = e.attempt_id
      AND c.refund_key LIKE 'case:%' AND c.amount_paisa = COALESCE(e.amount_paisa, p.amount_paisa))
) n WHERE n.amount_paisa IS NOT NULL AND n.amount_paisa > 0`;

const fromCases = (scope: string) => `INSERT OR IGNORE INTO credit_notes (${COLS})
SELECT n.project_id, n.env, n.refund_key, n.attempt_id, n.gateway, n.month, ${NEXT_SEQ}, n.ts, n.amount_paisa, n.reason, n.refund_ref, ?1
FROM (
  SELECT r.project_id, r.env, 'case:' || r.id AS refund_key, r.attempt_id, r.gateway, r.resolved_at AS ts, r.amount_paisa, r.reason, r.refund_ref,
    ${MONTH("r.resolved_at")} AS month
  FROM refund_cases r
  WHERE r.status = 'refunded' AND r.resolved_at IS NOT NULL AND ${scope}
    AND NOT EXISTS (SELECT 1 FROM credit_notes c WHERE c.project_id = r.project_id AND c.env = r.env AND c.refund_key = 'case:' || r.id)
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id = r.project_id AND e.env = r.env AND e.attempt_id = r.attempt_id AND e.type = 'payment.refunded')
    AND NOT EXISTS (SELECT 1 FROM credit_notes c WHERE c.project_id = r.project_id AND c.env = r.env AND c.attempt_id = r.attempt_id AND c.refund_key NOT LIKE 'case:%')
) n WHERE n.amount_paisa > 0`;

const PROJECT_EVENTS = fromEvents("e.project_id = ?2 AND e.env = ?3 AND e.ts >= ?4 AND e.ts < ?5");
const PROJECT_CASES = fromCases("r.project_id = ?2 AND r.env = ?3 AND r.resolved_at >= ?4 AND r.resolved_at < ?5");
const ALL_EVENTS = fromEvents("e.received_at >= ?2");
const ALL_CASES = fromCases("r.resolved_at >= ?2");

/** Numbers new refunds of one project environment whose refund time is in [from, to). Two statements. */
export function captureProjectStatements(env: Env, projectId: string, envName: string, from: number, to: number, t: number): D1PreparedStatement[] {
  return [env.DB.prepare(PROJECT_EVENTS).bind(t, projectId, envName, from, to), env.DB.prepare(PROJECT_CASES).bind(t, projectId, envName, from, to)];
}

/** Daily cron: numbers refunds received or resolved since `since`, across all projects. */
export async function captureAll(env: Env, since: number, t: number): Promise<number> {
  const res = await env.DB.batch([env.DB.prepare(ALL_EVENTS).bind(t, since), env.DB.prepare(ALL_CASES).bind(t, since)]);
  return res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
}

export const creditNoteNo = (month: string, seq: number) => `CN-${month}-${String(seq).padStart(4, "0")}`;
