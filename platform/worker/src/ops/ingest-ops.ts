// The v2 parts of ingest (SPEC-v2 sections 1, 4.1 and 4.4), kept out of ingest.ts so it only makes three calls:
//   eventOps()        per-event values for the payments upsert (customer hash and mask, refund amount, gw_env)
//   refStatements()   payment_refs rows for the main batch (one multi-row INSERT OR IGNORE per 32 refs)
//   afterStatements() duplicate detection, refund-case auto-resolve and doctor findings, appended to the
//                     post-batch D1 batch; each is one statement, most only when the batch needs them
import { DOCTOR_CHECKS, type DoctorCode, type PaymentEvent } from "@paynp/shared";
import type { IngestTransition } from "../alerts/engine.ts";
import { DAY, MINUTE } from "../lib/util.ts";
import { hashCustomer, projectSalt, type HashedCustomer } from "./customer.ts";

/** D1 allows 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

export interface EventOps {
  /** Refunded amount for payment.refunded, else null. */
  refund_paisa: number | null;
  /** The amount for the payments row: never a refund amount. */
  amount_paisa: number | null;
  /** The status the event implies, with a bare payment.refunded meaning a full refund. */
  status: string | null;
  customer: HashedCustomer | null;
  gw_env: string | null;
}

export async function eventOps(env: Env, projectId: string, events: PaymentEvent[], status: (e: PaymentEvent) => string | null, salt?: string | null): Promise<EventOps[]> {
  const needsSalt = events.some((e) => e.customer?.phone || e.customer?.email);
  const s = needsSalt ? await projectSalt(env, projectId, salt) : "";
  return Promise.all(
    events.map(async (e) => {
      const refund = e.type === "payment.refunded";
      return {
        refund_paisa: refund ? (e.amount_paisa ?? null) : null,
        amount_paisa: refund ? null : (e.amount_paisa ?? null),
        status: refund && e.amount_paisa === undefined ? (status(e) ?? "refunded") : status(e),
        customer: await hashCustomer(s, e.customer),
        gw_env: e.data?.gw_env ?? null,
      };
    }),
  );
}

/** Every reference that identifies a payment: attempt id, order id, provider refs, refund refs, customer hashes. */
export function refStatements(env: Env, projectId: string, envName: string, events: PaymentEvent[], ops: EventOps[]): D1PreparedStatement[] {
  const refs = new Map<string, [string, string, string]>();
  const add = (ref: string | null | undefined, attempt: string, kind: string) => {
    if (!ref) return;
    const k = `${ref}\u0000${attempt}`;
    if (!refs.has(k)) refs.set(k, [ref, attempt, kind]);
  };
  events.forEach((e, i) => {
    add(e.attempt_id, e.attempt_id, "attempt");
    add(e.order_id, e.attempt_id, "order");
    add(e.data?.provider_ref, e.attempt_id, "provider");
    add(e.data?.refund_ref, e.attempt_id, "refund");
    for (const h of ops[i].customer?.hashes ?? []) add(h, e.attempt_id, "customer");
  });
  const rows = [...refs.values()];
  const per = Math.floor((MAX_PARAMS - 2) / 3);
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const values = part.map((_, k) => `(?1, ?2, ?${3 + k * 3}, ?${4 + k * 3}, ?${5 + k * 3})`).join(", ");
    out.push(env.DB.prepare(`INSERT OR IGNORE INTO payment_refs (project_id, env, ref, attempt_id, kind) VALUES ${values}`).bind(projectId, envName, ...part.flat()));
  }
  return out;
}

export const DUPLICATE_WINDOW = 30 * MINUTE;

// For every newly paid payment p, another paid payment q in the same project+env with the same order id, or the same
// customer hash and amount started within 30 minutes. The later-paid of the two (finished_at, then attempt id) is the
// one to refund; the earliest paid match is kept as related. refund_cases_dup makes it one case per payment.
const DUPLICATES = (n: number) => `
WITH np(a) AS (VALUES ${Array.from({ length: n }, (_, i) => `(?${4 + i})`).join(", ")}),
pairs AS (
  SELECT p.attempt_id AS pa, q.attempt_id AS qa,
    (q.finished_at < p.finished_at OR (q.finished_at = p.finished_at AND q.attempt_id < p.attempt_id)) AS p_later,
    (p.order_id IS NOT NULL AND q.order_id = p.order_id) AS same_order
  FROM np
  JOIN payments p ON p.project_id = ?1 AND p.env = ?2 AND p.attempt_id = np.a AND p.status = 'paid'
  JOIN payments q ON q.project_id = ?1 AND q.env = ?2 AND q.attempt_id <> p.attempt_id AND q.status = 'paid'
    AND ((p.order_id IS NOT NULL AND q.order_id = p.order_id)
      OR (p.customer_hash IS NOT NULL AND q.customer_hash = p.customer_hash AND q.amount_paisa = p.amount_paisa
          AND ABS(q.started_at - p.started_at) <= ${DUPLICATE_WINDOW}))
)
INSERT OR IGNORE INTO refund_cases (id, project_id, env, kind, status, attempt_id, related_attempt_id, gateway, amount_paisa, reason, created_at, updated_at)
SELECT 'rfc_' || lower(hex(randomblob(12))), ?1, ?2, 'duplicate', 'open', later.attempt_id, earlier.attempt_id, later.gateway,
  COALESCE(later.amount_paisa, 0), CASE WHEN pairs.same_order THEN 'same_order' ELSE 'same_customer_amount' END, ?3, ?3
FROM pairs
JOIN payments later ON later.project_id = ?1 AND later.env = ?2 AND later.attempt_id = CASE WHEN pairs.p_later THEN pairs.pa ELSE pairs.qa END
JOIN payments earlier ON earlier.project_id = ?1 AND earlier.env = ?2 AND earlier.attempt_id = CASE WHEN pairs.p_later THEN pairs.qa ELSE pairs.pa END
ORDER BY earlier.finished_at, earlier.attempt_id
RETURNING id AS case_id, attempt_id, related_attempt_id, reason`;

// A payment.refunded event or a refunded status closes the payment's open cases.
const RESOLVE_REFUNDED = (n: number) => `
WITH r(a, ref) AS (VALUES ${Array.from({ length: n }, (_, i) => `(?${4 + i * 2}, ?${5 + i * 2})`).join(", ")})
UPDATE refund_cases SET status = 'refunded', updated_at = ?3, resolved_at = ?3, resolved_by = 'auto',
  refund_ref = COALESCE((SELECT MAX(ref) FROM r WHERE r.a = refund_cases.attempt_id), refund_ref)
WHERE project_id = ?1 AND env = ?2 AND status IN ('open', 'requested', 'failed') AND attempt_id IN (SELECT a FROM r)`;

const UPSERT_FINDING_TAIL = `ON CONFLICT (project_id, env, code, gateway) DO UPDATE SET
  last_seen = MAX(doctor_findings.last_seen, excluded.last_seen), count = doctor_findings.count + excluded.count,
  example_attempt = excluded.example_attempt, severity = excluded.severity, resolved_at = NULL`;

// >= 3 of the last 10 payments on the gateway under 100 paisa while the project's 30-day median is over 10000.
const RUPEE_AMOUNTS = `INSERT INTO doctor_findings (project_id, env, code, severity, gateway, first_seen, last_seen, count, example_attempt)
SELECT ?1, ?2, 'amount_looks_like_rupees', 'warning', ?4, ?3, ?3, 1, ?5
WHERE (SELECT COUNT(*) FROM (SELECT amount_paisa FROM payments WHERE project_id = ?1 AND env = ?2 AND gateway = ?4 AND amount_paisa IS NOT NULL
         ORDER BY started_at DESC LIMIT 10) WHERE amount_paisa < 100) >= 3
  AND (SELECT amount_paisa FROM payments WHERE project_id = ?1 AND env = ?2 AND amount_paisa IS NOT NULL AND started_at > ?6 ORDER BY amount_paisa
         LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM payments WHERE project_id = ?1 AND env = ?2 AND amount_paisa IS NOT NULL AND started_at > ?6)) > 10000
${UPSERT_FINDING_TAIL}`;

// >= 3 failed signature checks in 10 minutes on the gateway.
const SIGNATURE_BURST = `INSERT INTO doctor_findings (project_id, env, code, severity, gateway, first_seen, last_seen, count, example_attempt)
SELECT ?1, ?2, 'signature_failures', 'critical', ?4, ?3, ?3, ?6, ?5
WHERE (SELECT COUNT(*) FROM events WHERE project_id = ?1 AND env = ?2 AND gateway = ?4 AND type = 'signature.checked'
         AND json_extract(data, '$.valid') = 0 AND ts > ?3 - ${10 * MINUTE}) >= 3
${UPSERT_FINDING_TAIL}`;

export interface FindingHit {
  code: DoctorCode;
  gateway: string;
  count: number;
  example: string | null;
}

export function findingStatements(env: Env, projectId: string, envName: string, hits: FindingHit[], t: number): D1PreparedStatement[] {
  const per = Math.floor((MAX_PARAMS - 3) / 5);
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < hits.length; i += per) {
    const part = hits.slice(i, i + per);
    const values = part.map((_, k) => `(?1, ?2, ?${4 + k * 5}, ?${5 + k * 5}, ?${6 + k * 5}, ?3, ?3, ?${7 + k * 5}, ?${8 + k * 5})`).join(", ");
    out.push(
      env.DB.prepare(`INSERT INTO doctor_findings (project_id, env, code, severity, gateway, first_seen, last_seen, count, example_attempt) VALUES ${values} ${UPSERT_FINDING_TAIL}`).bind(
        projectId, envName, t, ...part.flatMap((h) => [h.code, DOCTOR_CHECKS[h.code].severity, h.gateway, h.count, h.example]),
      ),
    );
  }
  return out;
}

/** Findings that follow from the batch alone (no query needed). */
export function batchFindings(envName: string, transitions: IngestTransition[]): FindingHit[] {
  const live = envName === "live";
  const hits = new Map<string, FindingHit>();
  const hit = (code: DoctorCode, gateway: string, attempt: string) => {
    const k = `${code}|${gateway}`;
    const h = hits.get(k);
    if (h) {
      h.count++;
      h.example = attempt;
    } else hits.set(k, { code, gateway, count: 1, example: attempt });
  };
  for (const { event: e, old, payment: p } of transitions) {
    if (live && e.data?.gw_env === "sandbox") hit("sandbox_gateway_in_live", e.gateway, e.attempt_id);
    if (live && e.type === "payment.started" && e.data?.return_https === false) hit("http_return_url", e.gateway, e.attempt_id);
    if (live && e.type === "payment.started" && p.gateway === "khalti" && e.amount_paisa !== undefined && e.amount_paisa < 1000) hit("amount_looks_like_rupees", "khalti", e.attempt_id);
    if (e.type === "payment.fulfilled" && p.status !== "paid") hit("fulfil_without_paid", p.gateway, e.attempt_id);
    if (e.type === "payment.fulfilled" && p.fulfil_count >= 2 && (old?.fulfil_count ?? 0) < 2) hit("double_fulfilment", p.gateway, e.attempt_id);
  }
  return [...hits.values()];
}

export interface DuplicateHit {
  case_id: string;
  attempt_id: string;
  related_attempt_id: string;
  reason: "same_order" | "same_customer_amount";
}

export interface AfterOps {
  statements: D1PreparedStatement[];
  /** Reads the results of `statements` (in order) and marks the transitions that produced a duplicate case. */
  apply(results: D1Result[]): DuplicateHit[];
}

/** Post-batch statements for duplicates, refund auto-resolve and doctor findings. */
export function afterStatements(env: Env, projectId: string, envName: string, transitions: IngestTransition[], t: number): AfterOps {
  const statements: D1PreparedStatement[] = [];

  const newlyPaid = [...new Set(transitions.filter((tr) => tr.payment.status === "paid" && tr.old?.status !== "paid").map((tr) => tr.payment.attempt_id))];
  const dupIdx: number[] = [];
  const per = MAX_PARAMS - 3;
  for (let i = 0; i < newlyPaid.length; i += per) {
    const part = newlyPaid.slice(i, i + per);
    dupIdx.push(statements.length);
    statements.push(env.DB.prepare(DUPLICATES(part.length)).bind(projectId, envName, t, ...part));
  }

  const refunded = new Map<string, string | null>();
  for (const tr of transitions) {
    if (tr.event.type === "payment.refunded" || (tr.payment.status === "refunded" && tr.old?.status !== "refunded")) {
      refunded.set(tr.payment.attempt_id, tr.event.data?.refund_ref ?? refunded.get(tr.payment.attempt_id) ?? null);
    }
  }
  const rows = [...refunded];
  for (let i = 0; i < rows.length; i += Math.floor((MAX_PARAMS - 3) / 2)) {
    const part = rows.slice(i, i + Math.floor((MAX_PARAMS - 3) / 2));
    statements.push(env.DB.prepare(RESOLVE_REFUNDED(part.length)).bind(projectId, envName, t, ...part.flat()));
  }

  statements.push(...findingStatements(env, projectId, envName, batchFindings(envName, transitions), t));
  const gateways = (pred: (tr: IngestTransition) => boolean) => {
    const m = new Map<string, { n: number; example: string }>();
    for (const tr of transitions.filter(pred)) m.set(tr.event.gateway, { n: (m.get(tr.event.gateway)?.n ?? 0) + 1, example: tr.event.attempt_id });
    return m;
  };
  if (envName === "live") {
    for (const [gw, { example }] of gateways((tr) => tr.event.type === "payment.started" && tr.event.amount_paisa !== undefined && tr.event.amount_paisa < 100)) {
      statements.push(env.DB.prepare(RUPEE_AMOUNTS).bind(projectId, envName, t, gw, example, t - 30 * DAY));
    }
  }
  for (const [gw, { n, example }] of gateways((tr) => tr.event.type === "signature.checked" && tr.event.data?.valid === false)) {
    statements.push(env.DB.prepare(SIGNATURE_BURST).bind(projectId, envName, t, gw, example, n));
  }

  return {
    statements,
    apply(results) {
      const hits: DuplicateHit[] = [];
      for (const i of dupIdx) hits.push(...((results[i]?.results ?? []) as unknown as DuplicateHit[]));
      // The alert hangs on the last transition of either payment in the case (normally the later-paid one).
      for (const h of hits) {
        const tr = [...transitions].reverse().find((x) => x.payment.attempt_id === h.attempt_id) ?? [...transitions].reverse().find((x) => x.payment.attempt_id === h.related_attempt_id);
        if (tr) tr.duplicate = h;
      }
      return hits;
    },
  };
}
