// Cron work for v2 operations: paid_not_fulfilled incidents (SPEC-v2 4.3), the doctor checks that need time to pass
// (4.4: no_status_check_after_return, no_reconcile) and retention for the ops tables.
import { DOCTOR_CHECKS, OPEN_STATUSES, formatMoney, newId } from "@paynp/shared";
import type { RuleRow } from "../alerts/engine.ts";
import { DAY, HOUR, MINUTE, now } from "../lib/util.ts";
import { MAX_PARAMS } from "./ingest-ops.ts";


/**
 * Opens one pending incident per paid payment with no fulfilment after `after_min`, finished in the last 24 h.
 * Quiet for projects that never reported a payment.fulfilled in this env in the last 30 days: they do not report
 * fulfilment, so every payment would look unfulfilled. Returns how many incidents it opened.
 */
export async function openPaidNotFulfilled(env: Env, rule: RuleRow, t = now()): Promise<number> {
  const p = JSON.parse(rule.params || "{}") as { after_min?: number };
  const after = (Number(p.after_min) || 15) * MINUTE;
  const rows = (
    await env.DB.prepare(
      `SELECT p.attempt_id, p.gateway, p.amount_paisa, p.currency, p.order_id, p.finished_at FROM payments p
       WHERE p.project_id = ?1 AND p.env = ?2 AND p.status = 'paid' AND p.fulfil_count = 0 AND p.finished_at < ?3 AND p.finished_at > ?4
         AND EXISTS (SELECT 1 FROM payments f WHERE f.project_id = ?1 AND f.env = ?2 AND f.fulfilled_at > ?5)
         AND NOT EXISTS (SELECT 1 FROM alert_incidents i WHERE i.rule_id = ?6 AND i.attempt_id = p.attempt_id)
       ORDER BY p.finished_at LIMIT 50`,
    )
      .bind(rule.project_id, rule.env, t - after, t - DAY, t - 30 * DAY, rule.id)
      .all<{ attempt_id: string; gateway: string; amount_paisa: number | null; currency: string; order_id: string | null; finished_at: number }>()
  ).results;
  if (!rows.length) return 0;
  const res = await env.DB.batch(
    rows.map((r) => {
      const mins = Math.round((t - r.finished_at) / MINUTE);
      const summary = `${r.attempt_id} on ${r.gateway}${r.amount_paisa != null ? ` (${formatMoney(r.amount_paisa, r.currency)})` : ""}${r.order_id ? `, order ${r.order_id},` : ""} was paid ${mins} min ago and is not fulfilled`;
      const ctx = JSON.stringify({ attempt_id: r.attempt_id, gateway: r.gateway, amount_paisa: r.amount_paisa, order_id: r.order_id, paid_at: r.finished_at });
      return env.DB.prepare(
        `INSERT INTO alert_incidents (id, rule_id, project_id, state, opened_at, last_notified_at, summary, context, attempt_id, env, pending)
         SELECT ?, ?, ?, 'firing', ?, 0, ?, ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM alert_incidents WHERE rule_id = ? AND attempt_id = ?)`,
      ).bind(newId("inc", t), rule.id, rule.project_id, t, summary, ctx, r.attempt_id, rule.env, rule.id, r.attempt_id);
    }),
  );
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

interface CronHit {
  project_id: string;
  env: string;
  gateway: string;
  n: number;
  example: string | null;
}

function upsertHits(env: Env, code: "no_status_check_after_return" | "no_reconcile", hits: CronHit[], t: number, mode: "add" | "set"): D1PreparedStatement[] {
  const per = Math.floor((MAX_PARAMS - 3) / 5);
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < hits.length; i += per) {
    const part = hits.slice(i, i + per);
    const values = part.map((_, k) => `(?${4 + k * 5}, ?${5 + k * 5}, ?1, ?2, ?${6 + k * 5}, ?3, ?3, ?${7 + k * 5}, ?${8 + k * 5})`).join(", ");
    out.push(
      env.DB.prepare(
        `INSERT INTO doctor_findings (project_id, env, code, severity, gateway, first_seen, last_seen, count, example_attempt) VALUES ${values}
         ON CONFLICT (project_id, env, code, gateway) DO UPDATE SET last_seen = excluded.last_seen,
           count = ${mode === "add" ? "doctor_findings.count + excluded.count" : "excluded.count"}, example_attempt = excluded.example_attempt, resolved_at = NULL`,
      ).bind(code, DOCTOR_CHECKS[code].severity, t, ...part.flatMap((h) => [h.project_id, h.env, h.gateway, h.n, h.example])),
    );
  }
  return out;
}

/**
 * Doctor checks that need time to pass. Each cron minute looks at the callbacks whose ts fell in one whole minute,
 * two minutes back, so every callback is judged once and has had its 60 s. no_reconcile runs every 15 minutes.
 */
export async function runDoctorCron(env: Env, t = now()): Promise<Record<string, number>> {
  const minuteStart = Math.floor(t / MINUTE) * MINUTE;
  const from = minuteStart - 2 * MINUTE;
  const to = minuteStart - MINUTE;
  const noCheck = (
    await env.DB.prepare(
      // events_callbacks_by_ts (migrations/0011): reads only this minute's callbacks, not every recent event.
      `SELECT cb.project_id, cb.env, cb.gateway, COUNT(*) AS n, MAX(cb.attempt_id) AS example FROM events cb INDEXED BY events_callbacks_by_ts
       WHERE cb.type = 'callback.received' AND cb.ts >= ?1 AND cb.ts < ?2
         AND NOT EXISTS (SELECT 1 FROM events x WHERE x.project_id = cb.project_id AND x.env = cb.env AND x.attempt_id = cb.attempt_id
           AND x.ts >= cb.ts - 1000 AND x.ts <= cb.ts + 60000
           AND ((x.type = 'gateway.request' AND json_extract(x.data, '$.op') IN ('status', 'lookup')) OR x.type = 'reconcile.checked'))
       GROUP BY cb.project_id, cb.env, cb.gateway LIMIT 500`,
    )
      .bind(from, to)
      .all<CronHit>()
  ).results;
  const stmts = upsertHits(env, "no_status_check_after_return", noCheck, t, "add");

  let noRecon: CronHit[] = [];
  if (Math.floor(t / MINUTE) % 15 === 0) {
    noRecon = (
      await env.DB.prepare(
        `SELECT p.project_id, p.env, '' AS gateway, COUNT(*) AS n, MAX(p.attempt_id) AS example FROM payments p
         WHERE p.env = 'live' AND p.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(",")}) AND p.started_at < ?1 AND p.started_at > ?2
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.project_id AND e.env = 'live' AND e.type = 'reconcile.checked' AND e.ts > ?3)
         GROUP BY p.project_id LIMIT 500`,
      )
        .bind(t - HOUR, t - 7 * DAY, t - DAY)
        .all<CronHit>()
    ).results;
    stmts.push(...upsertHits(env, "no_reconcile", noRecon, t, "set"));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { no_status_check_after_return: noCheck.length, no_reconcile: noRecon.length };
}

/** Daily: expired status links, old actions, refs of deleted payments. */
export async function opsCleanup(env: Env, t = now()): Promise<Record<string, number>> {
  const [links, actions, refs] = await env.DB.batch([
    env.DB.prepare("DELETE FROM status_links WHERE expires_at < ?").bind(t - DAY),
    env.DB.prepare("DELETE FROM actions WHERE rowid IN (SELECT rowid FROM actions WHERE created_at < ? LIMIT 5000)").bind(t - 400 * DAY),
    env.DB.prepare(
      `DELETE FROM payment_refs WHERE rowid IN (SELECT r.rowid FROM payment_refs r WHERE NOT EXISTS
         (SELECT 1 FROM payments p WHERE p.project_id = r.project_id AND p.env = r.env AND p.attempt_id = r.attempt_id) LIMIT 5000)`,
    ),
  ]);
  return { status_links: links.meta.changes ?? 0, actions: actions.meta.changes ?? 0, payment_refs: refs.meta.changes ?? 0 };
}

/** Rows to delete with a project (projects.ts deleteProjectStatements). */
export function deleteOpsStatements(env: Env, projectId: string): D1PreparedStatement[] {
  return ["payment_refs", "refund_cases", "action_endpoints", "actions", "status_links", "doctor_findings"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE project_id = ?`).bind(projectId));
}
