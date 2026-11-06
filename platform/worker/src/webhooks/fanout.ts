// Turns the status changes of one ingest batch into webhook deliveries. Runs inside ingest, so it costs one D1
// statement per 19 webhook events (one on the free plan's 15-event batches) and never touches the network:
// the WebhookSender Durable Object sends them (deliver.ts).
import { newId, type WebhookEventType, type WebhookPayload } from "@paynp/shared";
import type { IngestTransition } from "../alerts/engine.ts";
import { toPayment } from "../lib/rows.ts";
import { MAX_PARAMS } from "../ops/ingest-ops.ts";

const BY_STATUS: Partial<Record<string, WebhookEventType>> = {
  pending: "payment.processing",
  paid: "payment.succeeded",
  failed: "payment.failed",
  canceled: "payment.canceled",
  expired: "payment.expired",
  refunded: "payment.refunded",
};

/** The webhook an accepted event causes, if any. At most one per event. */
export function webhookEventFor(tr: IngestTransition): WebhookEventType | null {
  const { event, old, payment } = tr;
  // Every refund is news, including partial ones that leave the payment paid.
  if (event.type === "payment.refunded") return "payment.refunded";
  if (!old) return payment.status === "initiated" || payment.status === "unknown" ? "payment.created" : (BY_STATUS[payment.status] ?? null);
  if (old.status === payment.status) return null;
  return BY_STATUS[payment.status] ?? null;
}

// ?1 project, ?2 env, ?3 now; per event: event id, type, attempt id, payload, event time.
const COLS = 5;
const PER_STATEMENT = Math.floor((MAX_PARAMS - 3) / COLS);

const fanoutSql = (n: number) => `INSERT OR IGNORE INTO webhook_deliveries
  (id, endpoint_id, event_id, project_id, env, type, attempt_id, payload, created_at, status, attempts, next_at)
SELECT 'whd_' || lower(hex(randomblob(10))), w.id, v.column1, ?1, ?2, v.column2, v.column3, v.column4, v.column5, 'pending', 0, ?3
FROM (VALUES ${Array.from({ length: n }, (_, k) => `(${Array.from({ length: COLS }, (_, i) => `?${4 + k * COLS + i}`).join(", ")})`).join(", ")}) AS v
JOIN webhook_endpoints w ON w.project_id = ?1 AND w.env = ?2 AND w.enabled = 1
  AND (w.events = '*' OR EXISTS (SELECT 1 FROM json_each(w.events) j WHERE j.value = v.column2))`;

/** One INSERT ... SELECT per 19 events: a delivery for every enabled endpoint that subscribes to the type. */
export function fanoutStatements(env: Env, projectId: string, envName: string, transitions: IngestTransition[], t: number): D1PreparedStatement[] {
  const rows: (string | number)[][] = [];
  for (const tr of transitions) {
    const type = webhookEventFor(tr);
    if (!type) continue;
    const ts = Date.parse(tr.event.ts);
    const payload: WebhookPayload = { type, timestamp: new Date(ts).toISOString(), data: toPayment(tr.payment) };
    rows.push([newId("msg", t), type, tr.payment.attempt_id, JSON.stringify(payload), ts]);
  }
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += PER_STATEMENT) {
    const part = rows.slice(i, i + PER_STATEMENT);
    out.push(env.DB.prepare(fanoutSql(part.length)).bind(projectId, envName, t, ...part.flat()));
  }
  return out;
}
