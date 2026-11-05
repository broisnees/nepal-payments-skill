// One fixture for the rollup parity test: batches of events that exercise every rollup rule in SPEC section 4,
// sent in an order that is deliberately not time order. Fixed timestamps, so both sides see the same minutes.
import type { PaymentEvent } from "../../shared/src/events.ts";

const T0 = Date.UTC(2026, 10, 5, 6, 0, 0); // 11:45 NPT
let n = 0;
function ev(type: PaymentEvent["type"], attempt: string, offsetMs: number, extra: Partial<PaymentEvent> = {}, gateway = "esewa"): PaymentEvent {
  n++;
  return { id: `evt_fx${String(n).padStart(4, "0")}`, type, ts: new Date(T0 + offsetMs).toISOString(), attempt_id: attempt, gateway, ...extra };
}

// Happy path, spread over two minutes.
const paid = [
  ev("payment.started", "p1", 0, { amount_paisa: 10000, status: "initiated", order_id: "ORD-1" }),
  ev("payment.redirected", "p1", 150, { data: { method: "POST", endpoint: "/api/epay/main/v2/form" } }),
  ev("callback.received", "p1", 61_000, { data: { method: "GET", source: "return" } }),
  ev("signature.checked", "p1", 61_004, { duration_ms: 1, data: { valid: true } }),
  ev("gateway.request", "p1", 61_010, { duration_ms: 612, data: { op: "status", http_status: 200, provider_status: "COMPLETE", provider_ref: "0LD5CEH" } }),
  ev("status.changed", "p1", 61_700, { status: "paid", data: { from: "initiated", to: "paid" } }),
  ev("payment.fulfilled", "p1", 61_900),
];
// Final status arrives before an older pending one: pending must not undo it.
const outOfOrder = [
  ev("payment.started", "p2", 1_000, { amount_paisa: 25050, status: "initiated" }, "khalti"),
  ev("status.changed", "p2", 90_000, { status: "failed", data: { to: "failed", reason: "amount_mismatch", message: "Paid 250.00, expected 250.50" } }, "khalti"),
  ev("reconcile.checked", "p2", 30_000, { status: "pending", data: { source: "reconcile", provider_status: "Pending" } }, "khalti"),
  ev("gateway.request", "p2", 29_000, { duration_ms: 7000, data: { op: "lookup", http_status: 503 } }, "khalti"),
  ev("gateway.request", "p2", 29_500, { duration_ms: 3000, data: { op: "lookup", reason: "timeout" } }, "khalti"),
];
// paid, then refunded later; then a stale "pending" that must be ignored; fulfilled twice.
const refund = [
  ev("payment.started", "p3", 2_000, { amount_paisa: 5000, status: "initiated" }, "fonepay"),
  ev("status.changed", "p3", 40_000, { status: "paid", data: { to: "paid" } }, "fonepay"),
  ev("payment.fulfilled", "p3", 40_100, {}, "fonepay"),
  ev("payment.fulfilled", "p3", 40_200, {}, "fonepay"),
  ev("status.changed", "p3", 200_000, { status: "refunded", data: { from: "paid", to: "refunded" } }, "fonepay"),
  ev("status.changed", "p3", 50_000, { status: "pending", data: { to: "pending" } }, "fonepay"),
];
// Bad signature then error; no status ever; a payment whose first event is not payment.started.
const bad = [
  ev("callback.received", "p4", 5_000, { data: { method: "GET" } }),
  ev("signature.checked", "p4", 5_010, { data: { valid: false, reason: "bad_signature" } }),
  ev("error", "p4", 5_020, { data: { reason: "bad_signature", message: "eSewa: bad signature on data" } }),
  ev("gateway.request", "p5", 3_000, { duration_ms: 120, data: { op: "status", http_status: 200, provider_code: "ES104" } }),
  ev("status.changed", "p5", 3_100, { status: "failed", data: { to: "failed", provider_code: "ES104" } }),
  // failed, then paid later (a final status replaced by a newer final status)
  ev("status.changed", "p5", 400_000, { status: "paid", data: { from: "failed", to: "paid" } }),
];

// v2: gw_env last seen, a partial then a completing payment.refunded, a bare payment.refunded (full refund),
// a name-only customer (no hash, so both sides agree without sharing a salt), fulfilled_at.
const v2 = [
  ev("payment.started", "p6", 6_000, { amount_paisa: 20000, status: "initiated", customer: { name: "Sita" } }, "khalti"),
  ev("payment.redirected", "p6", 6_100, { data: { method: "GET", endpoint: "/", gw_env: "sandbox" } }, "khalti"),
  ev("status.changed", "p6", 70_000, { status: "paid", data: { to: "paid" } }, "khalti"),
  ev("payment.fulfilled", "p6", 70_100, {}, "khalti"),
  ev("payment.refunded", "p6", 300_000, { amount_paisa: 5000, data: { refund_ref: "RF-1" } }, "khalti"),
  ev("payment.refunded", "p6", 310_000, { amount_paisa: 15000, data: { refund_ref: "RF-2", action_id: "act_1" } }, "khalti"),
  ev("payment.started", "p7", 7_000, { amount_paisa: 3000, status: "initiated" }, "esewa"),
  ev("status.changed", "p7", 8_000, { status: "paid", data: { to: "paid" } }, "esewa"),
  ev("payment.refunded", "p7", 320_000, { data: { refund_reason: "duplicate" } }, "esewa"),
];

/** Batches in arrival order. Duplicates within a batch and across batches included. */
export const FIXTURE_BATCHES: PaymentEvent[][] = [
  [paid[0], paid[1], outOfOrder[0], refund[0]],
  [outOfOrder[1], paid[5], paid[2], paid[3], paid[4]],
  [outOfOrder[2], outOfOrder[3], outOfOrder[4], refund[4], refund[1]],
  [refund[2], refund[3], refund[5], paid[6], paid[6]],
  [bad[0], bad[1], bad[2], bad[3], bad[4], bad[5], paid[0]],
  [v2[1], v2[0], v2[2], v2[3], v2[6], v2[7]],
  [v2[5], v2[4], v2[8]],
];
export const FIXTURE_T0 = T0;
