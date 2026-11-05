// Alert evaluation (platform/SPEC.md section 8).
//
// Aggregate rules (failure_rate, stuck_pending, signature_failure, gateway_errors, gateway_slow, no_traffic) keep at most
// one firing incident per rule. The cron evaluates them every minute: a trigger opens an incident and notifies; while
// firing, it notifies again only after cooldown_min and only if the summary changed; two clear evaluations in a row
// resolve it and send a resolved message. signature_failure is also checked on ingest (it can open, never resolve there).
//
// Per-payment rules (payment_failed, amount_mismatch, double_fulfilment) open one incident per payment on ingest, marked
// pending. double_payment (v2) is per-payment on ingest too; paid_not_fulfilled (v2) opens per-payment incidents from
// the cron (ops/cron-ops.ts) and resolves on ingest when payment.fulfilled arrives. flushPending() sends each channel at most one message per clock minute listing every pending payment; what a
// throttled channel misses goes out with the next cron run.
import { OPEN_STATUSES, newId, type PaymentEvent, type RuleType } from "@paynp/shared";
import { DAY, MINUTE, badRequest, now, parseJson } from "../lib/util.ts";
import { openPaidNotFulfilled } from "../ops/cron-ops.ts";
import type { DuplicateHit } from "../ops/ingest-ops.ts";
import type { PaymentRow } from "../types.ts";
import { deliverWithRetry, loadChannels, projectLink, sendToChannel, type ChannelRow, type Message } from "./notify.ts";

export interface RuleRow {
  id: string;
  project_id: string;
  env: string;
  type: RuleType;
  params: string;
  channel_ids: string;
  cooldown_min: number;
  enabled: number;
  created_at: number;
}

export interface IncidentRow {
  id: string;
  rule_id: string;
  project_id: string;
  state: "firing" | "resolved";
  opened_at: number;
  resolved_at: number | null;
  last_notified_at: number;
  summary: string;
  context: string | null;
  clear_evals: number;
  attempt_id: string | null;
  env: string | null;
  pending: number;
}

export interface IngestTransition {
  event: PaymentEvent;
  old: Pick<PaymentRow, "status" | "fulfil_count"> | null;
  payment: PaymentRow;
  /** Set when this transition opened a duplicate-payment refund case. */
  duplicate?: DuplicateHit;
}

export interface Evaluation {
  triggered: boolean;
  summary: string;
  context: Record<string, unknown>;
}

export const PER_PAYMENT: RuleType[] = ["payment_failed", "amount_mismatch", "double_fulfilment", "double_payment"];
export const AGGREGATE: RuleType[] = ["failure_rate", "stuck_pending", "signature_failure", "gateway_errors", "gateway_slow", "no_traffic"];
/** Per-payment incidents opened by the cron. */
export const CRON_PER_PAYMENT: RuleType[] = ["paid_not_fulfilled"];
export const RULE_TYPES: RuleType[] = [...PER_PAYMENT, ...AGGREGATE, ...CRON_PER_PAYMENT];

export const RULE_LABEL: Record<RuleType, string> = {
  payment_failed: "Payment failed",
  failure_rate: "High failure rate",
  stuck_pending: "Payments stuck pending",
  amount_mismatch: "Amount mismatch",
  signature_failure: "Signature failures",
  gateway_errors: "Gateway errors",
  gateway_slow: "Gateway slow",
  double_fulfilment: "Double fulfilment",
  no_traffic: "No traffic",
  double_payment: "Double payment",
  paid_not_fulfilled: "Paid but not fulfilled",
};

const DEFAULTS: Record<RuleType, Record<string, unknown>> = {
  payment_failed: {},
  failure_rate: { threshold_pct: 20, window_min: 15, min_payments: 5 },
  stuck_pending: { older_than_min: 30 },
  amount_mismatch: {},
  signature_failure: { threshold: 1, window_min: 10 },
  gateway_errors: { error_rate_pct: 20, window_min: 10, min_requests: 5 },
  gateway_slow: { avg_ms: 5000, window_min: 10 },
  double_fulfilment: {},
  no_traffic: { window_min: 60 },
  double_payment: {},
  paid_not_fulfilled: { after_min: 15 },
};

type Kind = "pos" | "nonneg" | "pct" | "gateway" | "gateways";
const PARAM_KINDS: Record<RuleType, Record<string, Kind>> = {
  payment_failed: { gateways: "gateways", min_amount_paisa: "nonneg" },
  failure_rate: { threshold_pct: "pct", window_min: "pos", min_payments: "pos", gateway: "gateway" },
  stuck_pending: { older_than_min: "pos" },
  amount_mismatch: {},
  signature_failure: { threshold: "pos", window_min: "pos" },
  gateway_errors: { gateway: "gateway", error_rate_pct: "pct", window_min: "pos", min_requests: "pos" },
  gateway_slow: { gateway: "gateway", avg_ms: "pos", window_min: "pos" },
  double_fulfilment: {},
  no_traffic: { window_min: "pos" },
  double_payment: {},
  paid_not_fulfilled: { after_min: "pos" },
};

/** Validates rule params for the API and fills defaults. Unknown keys are refused so typos do not silently do nothing. */
export function normalizeParams(type: RuleType, input: unknown): Record<string, unknown> {
  const kinds = PARAM_KINDS[type];
  const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULTS[type] };
  for (const [k, v] of Object.entries(src)) {
    const kind = kinds[k];
    if (!kind) throw badRequest(`unknown param for ${type}: ${k}`);
    if (v === null || v === undefined) {
      delete out[k];
      continue;
    }
    const num = typeof v === "number" && Number.isFinite(v);
    if (kind === "pos" && !(num && v > 0 && v <= 100_000_000)) throw badRequest(`${k} must be a positive number`);
    if (kind === "nonneg" && !(num && v >= 0)) throw badRequest(`${k} must be a non-negative number`);
    if (kind === "pct" && !(num && v > 0 && v <= 100)) throw badRequest(`${k} must be between 0 and 100`);
    if (kind === "gateway" && !(typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v))) throw badRequest(`${k} must be a gateway id`);
    if (kind === "gateways" && !(Array.isArray(v) && v.every((g) => typeof g === "string" && /^[a-z0-9_-]{1,32}$/.test(g)))) throw badRequest(`${k} must be a list of gateway ids`);
    if ((kind === "pos" || kind === "nonneg") && (k.endsWith("_min") || k === "threshold" || k.startsWith("min_")) && !Number.isInteger(v)) throw badRequest(`${k} must be an integer`);
    out[k] = v;
  }
  return out;
}

export const params = (rule: RuleRow) => ({ ...DEFAULTS[rule.type], ...parseJson<Record<string, unknown>>(rule.params, {}) }) as Record<string, number | string | string[] | undefined>;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
export const rupees = (paisa: number | null) => (paisa == null ? "" : `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

type StatSum = { started: number; paid: number; failed: number; req: number; err: number; ms: number };

async function statWindow(env: Env, rule: RuleRow, windowMin: number, t: number, gateway?: string, groupByGateway = false): Promise<(StatSum & { gateway: string })[]> {
  const nowMin = Math.floor(t / MINUTE);
  const r = await env.DB.prepare(
    `SELECT ${groupByGateway ? "gateway" : "'all' AS gateway"}, COALESCE(SUM(started),0) AS started, COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(failed),0) AS failed,
       COALESCE(SUM(gw_requests),0) AS req, COALESCE(SUM(gw_errors),0) AS err, COALESCE(SUM(gw_ms_total),0) AS ms
     FROM minute_stats WHERE project_id = ? AND env = ? AND minute > ? AND minute <= ?${gateway ? " AND gateway = ?" : ""}${groupByGateway ? " GROUP BY gateway" : ""}`,
  )
    .bind(rule.project_id, rule.env, nowMin - windowMin, nowMin, ...(gateway ? [gateway] : []))
    .all<StatSum & { gateway: string }>();
  return r.results;
}

/** Evaluates one aggregate rule at time t. Returns null when the rule does not apply (no_traffic outside live). */
export async function evaluateRule(env: Env, rule: RuleRow, t: number): Promise<Evaluation | null> {
  const p = params(rule);
  const gateway = typeof p.gateway === "string" ? p.gateway : undefined;
  const windowMin = Number(p.window_min ?? 15);
  switch (rule.type) {
    case "failure_rate": {
      const [s] = await statWindow(env, rule, windowMin, t, gateway);
      const done = (s?.paid ?? 0) + (s?.failed ?? 0);
      const r = done ? s.failed / done : 0;
      const triggered = done >= Number(p.min_payments) && r * 100 >= Number(p.threshold_pct);
      return {
        triggered,
        summary: `${gateway ?? "All gateways"}: ${pct(r)} of payments failed (${s?.failed ?? 0} of ${done}) in the last ${windowMin} min`,
        context: { failed: s?.failed ?? 0, finished: done, rate: r, window_min: windowMin, gateway: gateway ?? null },
      };
    }
    case "gateway_errors":
    case "gateway_slow": {
      const rows = await statWindow(env, rule, windowMin, t, gateway, true);
      let worst: Evaluation = { triggered: false, summary: "", context: {} };
      for (const s of rows) {
        if (!s.req) continue;
        if (rule.type === "gateway_errors") {
          const r = s.err / s.req;
          const hit = s.req >= Number(p.min_requests) && r * 100 >= Number(p.error_rate_pct);
          if (hit && (!worst.triggered || r > Number(worst.context.rate))) {
            worst = { triggered: true, summary: `${s.gateway}: ${pct(r)} of gateway calls failed (${s.err} of ${s.req}) in the last ${windowMin} min`, context: { gateway: s.gateway, errors: s.err, requests: s.req, rate: r } };
          }
        } else {
          const avg = Math.round(s.ms / s.req);
          if (avg >= Number(p.avg_ms) && (!worst.triggered || avg > Number(worst.context.avg_ms))) {
            worst = { triggered: true, summary: `${s.gateway}: gateway calls averaged ${avg} ms over ${s.req} requests in the last ${windowMin} min`, context: { gateway: s.gateway, avg_ms: avg, requests: s.req } };
          }
        }
      }
      return worst;
    }
    case "stuck_pending": {
      const older = Number(p.older_than_min) * MINUTE;
      const r = await env.DB.prepare(
        `SELECT attempt_id, gateway, started_at FROM payments WHERE project_id = ? AND env = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})
         AND started_at < ? AND started_at > ? ORDER BY started_at LIMIT 101`,
      )
        .bind(rule.project_id, rule.env, ...OPEN_STATUSES, t - older, t - 7 * DAY)
        .all<{ attempt_id: string; gateway: string; started_at: number }>();
      const n = r.results.length;
      return {
        triggered: n > 0,
        summary: `${n > 100 ? "100+" : n} payment${n === 1 ? "" : "s"} open longer than ${p.older_than_min} min`,
        context: { count: n, attempts: r.results.slice(0, 10).map((x) => x.attempt_id) },
      };
    }
    case "signature_failure": {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND env = ? AND type = 'signature.checked' AND json_extract(data, '$.valid') = 0 AND ts > ?",
      )
        .bind(rule.project_id, rule.env, t - windowMin * MINUTE)
        .first<{ n: number }>();
      const n = r?.n ?? 0;
      return { triggered: n >= Number(p.threshold), summary: `${n} signature check${n === 1 ? "" : "s"} failed in the last ${windowMin} min`, context: { count: n, window_min: windowMin } };
    }
    case "no_traffic": {
      if (rule.env !== "live") return null;
      const nowMin = Math.floor(t / MINUTE);
      const r = await env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN minute > ?3 THEN started ELSE 0 END), 0) AS recent, COALESCE(SUM(started), 0) AS week
         FROM minute_stats WHERE project_id = ?1 AND env = ?2 AND minute > ?4`,
      )
        .bind(rule.project_id, rule.env, nowMin - windowMin, nowMin - 7 * 1440)
        .first<{ recent: number; week: number }>();
      // A project that never had traffic is not "down"; it just has not launched.
      const triggered = (r?.week ?? 0) > 0 && (r?.recent ?? 0) === 0;
      return { triggered, summary: `No payments started in the last ${windowMin} min`, context: { window_min: windowMin } };
    }
    default:
      return null;
  }
}

async function projectInfo(env: Env, projectId: string) {
  return (await env.DB.prepare("SELECT id, name FROM projects WHERE id = ?").bind(projectId).first<{ id: string; name: string }>()) ?? { id: projectId, name: projectId };
}

function incidentMessage(env: Env, kind: "incident.firing" | "incident.resolved", rule: RuleRow, inc: IncidentRow, project: { id: string; name: string }): Message {
  const label = RULE_LABEL[rule.type];
  return {
    kind,
    title: kind === "incident.firing" ? `${label}: ${inc.summary}` : `Resolved: ${label}`,
    lines: kind === "incident.firing" ? [`Project ${project.name} (${rule.env})`] : [`Project ${project.name} (${rule.env})`, `Was: ${inc.summary}`],
    link: projectLink(env, project.id, `/alerts?incident=${inc.id}`),
    payload: {
      project: { id: project.id, name: project.name },
      env: rule.env,
      rule: { id: rule.id, type: rule.type },
      incident: { id: inc.id, state: kind === "incident.firing" ? "firing" : "resolved", summary: inc.summary, opened_at: inc.opened_at, context: parseJson(inc.context, null) },
    },
  };
}

async function notifyRule(env: Env, rule: RuleRow, msg: Message, incidentIds: string[], t: number): Promise<void> {
  const channels = await loadChannels(env, rule.project_id, parseJson<string[]>(rule.channel_ids, []));
  await Promise.all(channels.map((ch) => sendToChannel(env, ch, msg, incidentIds, t)));
}

/** Applies one evaluation to the rule's open incident. `canResolve` is false for on-ingest checks. */
export async function applyEvaluation(env: Env, rule: RuleRow, ev: Evaluation, t: number, canResolve: boolean): Promise<"opened" | "renotified" | "firing" | "cleared" | "resolved" | "idle"> {
  const open = await env.DB.prepare("SELECT * FROM alert_incidents WHERE rule_id = ? AND state = 'firing' AND attempt_id IS NULL LIMIT 1").bind(rule.id).first<IncidentRow>();
  const ctx = JSON.stringify(ev.context);
  if (ev.triggered) {
    if (!open) {
      const inc: IncidentRow = {
        id: newId("inc", t), rule_id: rule.id, project_id: rule.project_id, state: "firing", opened_at: t, resolved_at: null,
        last_notified_at: t, summary: ev.summary, context: ctx, clear_evals: 0, attempt_id: null, env: rule.env, pending: 0,
      };
      // The partial unique guard is the SELECT above; two crons racing is prevented by the INSERT ... WHERE NOT EXISTS.
      const r = await env.DB.prepare(
        `INSERT INTO alert_incidents (id, rule_id, project_id, state, opened_at, last_notified_at, summary, context, clear_evals, env, pending)
         SELECT ?, ?, ?, 'firing', ?, ?, ?, ?, 0, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM alert_incidents WHERE rule_id = ? AND state = 'firing' AND attempt_id IS NULL)`,
      )
        .bind(inc.id, rule.id, rule.project_id, t, t, ev.summary, ctx, rule.env, rule.id)
        .run();
      if (!r.meta.changes) return "firing";
      await notifyRule(env, rule, incidentMessage(env, "incident.firing", rule, inc, await projectInfo(env, rule.project_id)), [inc.id], t);
      return "opened";
    }
    const due = t - open.last_notified_at >= rule.cooldown_min * MINUTE && ev.summary !== open.summary;
    if (due) {
      await env.DB.prepare("UPDATE alert_incidents SET clear_evals = 0, context = ?, summary = ?, last_notified_at = ? WHERE id = ?").bind(ctx, ev.summary, t, open.id).run();
      await notifyRule(env, rule, incidentMessage(env, "incident.firing", rule, { ...open, summary: ev.summary, context: ctx }, await projectInfo(env, rule.project_id)), [open.id], t);
      return "renotified";
    }
    await env.DB.prepare("UPDATE alert_incidents SET clear_evals = 0, context = ? WHERE id = ?").bind(ctx, open.id).run();
    return "firing";
  }
  if (!open || !canResolve) return "idle";
  if (open.clear_evals + 1 < 2) {
    await env.DB.prepare("UPDATE alert_incidents SET clear_evals = clear_evals + 1 WHERE id = ?").bind(open.id).run();
    return "cleared";
  }
  const r = await env.DB.prepare("UPDATE alert_incidents SET state = 'resolved', resolved_at = ?, clear_evals = clear_evals + 1 WHERE id = ? AND state = 'firing'").bind(t, open.id).run();
  if (r.meta.changes) await notifyRule(env, rule, incidentMessage(env, "incident.resolved", rule, open, await projectInfo(env, rule.project_id)), [open.id], t);
  return "resolved";
}

function perPaymentMatch(rule: RuleRow, tr: IngestTransition): string | null {
  const p = params(rule);
  const pay = tr.payment;
  const amt = pay.amount_paisa != null ? ` (${rupees(pay.amount_paisa)})` : "";
  switch (rule.type) {
    case "payment_failed": {
      if (pay.status !== "failed" || tr.old?.status === "failed") return null;
      const gws = Array.isArray(p.gateways) ? (p.gateways as string[]) : null;
      if (gws && gws.length && !gws.includes(pay.gateway)) return null;
      if (typeof p.min_amount_paisa === "number" && (pay.amount_paisa ?? 0) < p.min_amount_paisa) return null;
      return `${pay.attempt_id} failed on ${pay.gateway}${amt}${pay.last_reason ? `: ${pay.last_reason}` : ""}`;
    }
    case "amount_mismatch":
      return tr.event.data?.reason === "amount_mismatch" ? `${pay.attempt_id} on ${pay.gateway}${amt}: amount does not match the order` : null;
    case "double_fulfilment":
      return tr.event.type === "payment.fulfilled" && pay.fulfil_count >= 2 && (tr.old?.fulfil_count ?? 0) < 2 ? `${pay.attempt_id} on ${pay.gateway}${amt} was fulfilled ${pay.fulfil_count} times` : null;
    case "double_payment": {
      const d = tr.duplicate;
      if (!d) return null;
      return `${d.attempt_id} on ${pay.gateway}${amt} duplicates ${d.related_attempt_id} (${d.reason === "same_order" ? `same order${pay.order_id ? ` ${pay.order_id}` : ""}` : "same customer and amount within 30 min"}). Refund case ${d.case_id} is open.`;
    }
    default:
      return null;
  }
}

/** Per-event rules and the on-ingest signature check. Called after every accepted batch. */
export async function onIngest(env: Env, projectId: string, envName: string, transitions: IngestTransition[], t = now()): Promise<void> {
  if (!transitions.length) return;
  const rules = (
    await env.DB.prepare("SELECT * FROM alert_rules WHERE project_id = ? AND env = ? AND enabled = 1").bind(projectId, envName).all<RuleRow>()
  ).results;
  if (!rules.length) return;

  // Ingest has a D1 query budget (50 per invocation on the free plan), so the new incidents go in multi-row inserts
  // (one row per rule and payment; the NOT EXISTS keeps one firing incident per rule and payment).
  const inserts: D1PreparedStatement[] = [];
  const rows = new Map<string, [string, string, string, string, string]>();
  for (const rule of rules.filter((r) => PER_PAYMENT.includes(r.type))) {
    for (const tr of transitions) {
      const summary = perPaymentMatch(rule, tr);
      const k = `${rule.id}|${tr.payment.attempt_id}`;
      if (!summary || rows.has(k)) continue;
      const ctx = JSON.stringify({ attempt_id: tr.payment.attempt_id, gateway: tr.payment.gateway, amount_paisa: tr.payment.amount_paisa, reason: tr.payment.last_reason, order_id: tr.payment.order_id });
      rows.set(k, [newId("inc", t), rule.id, summary, ctx, tr.payment.attempt_id]);
    }
  }
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 19) {
    const part = list.slice(i, i + 19);
    inserts.push(
      env.DB.prepare(
        `INSERT INTO alert_incidents (id, rule_id, project_id, state, opened_at, last_notified_at, summary, context, attempt_id, env, pending)
         SELECT v.column1, v.column2, ?1, 'firing', ?2, 0, v.column3, v.column4, v.column5, ?3, 1
         FROM (VALUES ${part.map((_, k) => `(?${4 + k * 5}, ?${5 + k * 5}, ?${6 + k * 5}, ?${7 + k * 5}, ?${8 + k * 5})`).join(", ")}) AS v
         WHERE NOT EXISTS (SELECT 1 FROM alert_incidents i WHERE i.rule_id = v.column2 AND i.attempt_id = v.column5 AND i.state = 'firing')`,
      ).bind(projectId, t, envName, ...part.flat()),
    );
  }
  // A payment that ends up paid closes its payment_failed incident quietly; a fulfilled one closes paid_not_fulfilled.
  const paidNow = [...new Set(transitions.filter((tr) => tr.payment.status === "paid" && tr.old?.status !== "paid").map((tr) => tr.payment.attempt_id))];
  const fulfilled = [...new Set(transitions.filter((tr) => tr.event.type === "payment.fulfilled").map((tr) => tr.payment.attempt_id))];
  for (let i = 0; i < Math.max(paidNow.length, fulfilled.length); i += 45) {
    const a = paidNow.slice(i, i + 45);
    const b = fulfilled.slice(i, i + 45);
    const inList = (n: number) => (n ? Array.from({ length: n }, () => "?").join(",") : "NULL");
    inserts.push(
      env.DB.prepare(
        `UPDATE alert_incidents SET state = 'resolved', resolved_at = ?, pending = 0 WHERE project_id = ? AND state = 'firing' AND (
           (attempt_id IN (${inList(a.length)}) AND rule_id IN (SELECT id FROM alert_rules WHERE project_id = ? AND type = 'payment_failed'))
           OR (attempt_id IN (${inList(b.length)}) AND rule_id IN (SELECT id FROM alert_rules WHERE project_id = ? AND type = 'paid_not_fulfilled')))`,
      ).bind(t, projectId, ...a, projectId, ...b, projectId),
    );
  }
  if (inserts.length) await env.DB.batch(inserts);

  if (transitions.some((tr) => tr.event.type === "signature.checked" && tr.event.data?.valid === false)) {
    for (const rule of rules.filter((r) => r.type === "signature_failure")) {
      const ev = await evaluateRule(env, rule, t);
      if (ev?.triggered) await applyEvaluation(env, rule, ev, t, false);
    }
  }
  await flushPending(env, t, projectId);
}

/** Sends pending per-payment incidents, at most one message per channel per clock minute. */
export async function flushPending(env: Env, t = now(), projectId?: string): Promise<number> {
  const pending = (
    await env.DB.prepare(
      `SELECT i.*, r.channel_ids, r.type AS rule_type, r.env AS rule_env FROM alert_incidents i JOIN alert_rules r ON r.id = i.rule_id
       WHERE i.pending = 1 ${projectId ? "AND i.project_id = ?" : ""} ORDER BY i.opened_at LIMIT 500`,
    )
      .bind(...(projectId ? [projectId] : []))
      .all<IncidentRow & { channel_ids: string; rule_type: RuleType; rule_env: string }>()
  ).results;
  if (!pending.length) return 0;

  const ids = pending.map((p) => p.id);
  const done = (
    await env.DB.prepare(`SELECT incident_id, channel_id FROM notifications WHERE incident_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ incident_id: string; channel_id: string }>()
  ).results;
  const delivered = new Set(done.map((d) => `${d.incident_id}|${d.channel_id}`));

  // channel id -> incidents still owed to it
  const owed = new Map<string, typeof pending>();
  for (const inc of pending) {
    for (const ch of parseJson<string[]>(inc.channel_ids, [])) {
      if (delivered.has(`${inc.id}|${ch}`)) continue;
      if (!owed.has(ch)) owed.set(ch, []);
      owed.get(ch)!.push(inc);
    }
  }

  const minute = Math.floor(t / MINUTE);
  let sent = 0;
  const byProject = new Map<string, ChannelRow[]>();
  for (const pid of new Set(pending.map((p) => p.project_id))) {
    byProject.set(pid, await loadChannels(env, pid, [...owed.keys()]));
  }
  for (const [chId, owedIncs] of owed) {
    const channel = byProject.get(owedIncs[0].project_id)?.find((c) => c.id === chId);
    if (!channel) {
      owedIncs.forEach((i) => delivered.add(`${i.id}|${chId}`)); // deleted channel: nothing to send
      continue;
    }
    // One batch per channel per clock minute. The slot row is the atomic throttle: concurrent flushes
    // (one per ingest request) cannot both send; whoever loses leaves the rest to the next cron run.
    const slot = await env.DB.prepare("INSERT OR IGNORE INTO notify_slots (channel_id, minute) VALUES (?, ?)").bind(chId, minute).run();
    if (!slot.meta.changes) continue;
    // Claim each incident for this channel, so an incident is never sent twice to the same channel.
    // Multi-row claims (48 per statement) keep the ingest path inside its D1 query budget.
    const claimStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < owedIncs.length; i += 48) {
      const part = owedIncs.slice(i, i + 48);
      claimStmts.push(
        env.DB.prepare(
          `INSERT INTO notifications (id, incident_id, channel_id, sent_at, ok, error)
           SELECT v.column1, v.column2, ?1, ?2, 0, 'sending' FROM (VALUES ${part.map((_, k) => `(?${3 + k * 2}, ?${4 + k * 2})`).join(", ")}) AS v
           WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.incident_id = v.column2 AND n.channel_id = ?1)
           RETURNING id, incident_id`,
        ).bind(chId, t, ...part.flatMap((inc) => [newId("ntf", t), inc.id])),
      );
    }
    const claims = (await env.DB.batch(claimStmts)).flatMap((r) => r.results as { id: string; incident_id: string }[]);
    owedIncs.forEach((i) => delivered.add(`${i.id}|${chId}`));
    const claimedFor = new Set(claims.map((c) => c.incident_id));
    const incs = owedIncs.filter((i) => claimedFor.has(i.id));
    const claimed = claims.map((c) => c.id);
    if (!incs.length) {
      await env.DB.prepare("DELETE FROM notify_slots WHERE channel_id = ? AND minute = ?").bind(chId, minute).run();
      continue;
    }
    const project = await projectInfo(env, incs[0].project_id);
    const label = incs.length === 1 ? RULE_LABEL[incs[0].rule_type] : `${incs.length} payment alerts`;
    const msg: Message = {
      kind: "incident.batch",
      title: incs.length === 1 ? `${label}: ${incs[0].summary}` : `${label} in ${project.name}`,
      lines: [`Project ${project.name} (${incs[0].rule_env})`, ...incs.slice(0, 50).map((i) => `- ${RULE_LABEL[i.rule_type]}: ${i.summary}`), ...(incs.length > 50 ? [`and ${incs.length - 50} more`] : [])],
      link: incs.length === 1 && incs[0].attempt_id ? projectLink(env, project.id, `/payments/${encodeURIComponent(incs[0].attempt_id)}?env=${incs[0].rule_env}`) : projectLink(env, project.id, "/alerts"),
      payload: {
        project: { id: project.id, name: project.name },
        env: incs[0].rule_env,
        incidents: incs.map((i) => ({ id: i.id, rule_id: i.rule_id, rule_type: i.rule_type, summary: i.summary, attempt_id: i.attempt_id, context: parseJson(i.context, null), link: i.attempt_id ? projectLink(env, project.id, `/payments/${encodeURIComponent(i.attempt_id)}?env=${i.rule_env}`) : undefined })),
      },
    };
    const result = await deliverWithRetry(env, channel, msg);
    await env.DB.prepare(`UPDATE notifications SET ok = ?, error = ?, sent_at = ? WHERE id IN (${claimed.map(() => "?").join(",")})`)
      .bind(result.ok ? 1 : 0, result.error ?? null, t, ...claimed)
      .run();
    sent++;
  }

  const finished = pending.filter((inc) => parseJson<string[]>(inc.channel_ids, []).every((ch) => delivered.has(`${inc.id}|${ch}`)));
  if (finished.length) {
    await env.DB.prepare(`UPDATE alert_incidents SET pending = 0, last_notified_at = ? WHERE id IN (${finished.map(() => "?").join(",")})`).bind(t, ...finished.map((f) => f.id)).run();
  }
  return sent;
}

/** The every-minute cron: aggregate rules, pending batches, and closing day-old per-payment incidents. */
export async function runAlertCron(env: Env, t = now()): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const rules = (
    await env.DB.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND type IN (${AGGREGATE.map(() => "?").join(",")})`).bind(...AGGREGATE).all<RuleRow>()
  ).results;
  for (const rule of rules) {
    try {
      const ev = await evaluateRule(env, rule, t);
      if (!ev) continue;
      const outcome = await applyEvaluation(env, rule, ev, t, true);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (e) {
      console.error(JSON.stringify({ msg: "rule evaluation failed", rule: rule.id, error: String(e) }));
    }
  }
  const cronRules = (
    await env.DB.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND type IN (${CRON_PER_PAYMENT.map(() => "?").join(",")})`).bind(...CRON_PER_PAYMENT).all<RuleRow>()
  ).results;
  for (const rule of cronRules) {
    try {
      const opened = await openPaidNotFulfilled(env, rule, t);
      if (opened) counts.opened_per_payment = (counts.opened_per_payment ?? 0) + opened;
    } catch (e) {
      console.error(JSON.stringify({ msg: "rule evaluation failed", rule: rule.id, error: String(e) }));
    }
  }
  counts.batched = await flushPending(env, t);
  await env.DB.prepare("UPDATE alert_incidents SET state = 'resolved', resolved_at = ?, pending = 0 WHERE attempt_id IS NOT NULL AND state = 'firing' AND pending = 0 AND opened_at < ?")
    .bind(t, t - DAY)
    .run();
  return counts;
}

