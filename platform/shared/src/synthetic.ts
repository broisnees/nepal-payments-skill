// The synthetic eSewa trace behind `paynp test` and the dashboard's "send a test payment" button:
// started, redirected, callback, signature ok, status COMPLETE, paid, fulfilled.
import { newId, type PaymentEvent } from "./events.ts";

export function syntheticEsewaTrace(now = Date.now(), sdk?: PaymentEvent["sdk"]): PaymentEvent[] {
  const attempt = newId("att", now).toLowerCase();
  const order = `TEST-${attempt.slice(-6).toUpperCase()}`;
  const start = now - 45_000;
  const at = (ms: number) => new Date(start + ms).toISOString();
  const base = { attempt_id: attempt, gateway: "esewa", ...(sdk ? { sdk } : {}) };
  const ids = Array.from({ length: 7 }, (_, i) => newId("evt", start + i));
  return [
    { ...base, id: ids[0], type: "payment.started", ts: at(0), order_id: order, amount_paisa: 10000, status: "initiated" },
    { ...base, id: ids[1], type: "payment.redirected", ts: at(150), data: { method: "POST", endpoint: "/api/epay/main/v2/form" } },
    { ...base, id: ids[2], type: "callback.received", ts: at(38_000), data: { method: "GET", source: "return" } },
    { ...base, id: ids[3], type: "signature.checked", ts: at(38_004), duration_ms: 1, data: { valid: true } },
    { ...base, id: ids[4], type: "gateway.request", ts: at(38_010), duration_ms: 612, data: { op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200, provider_status: "COMPLETE", provider_ref: "0LD5CEH" } },
    { ...base, id: ids[5], type: "status.changed", ts: at(38_700), status: "paid", data: { from: "initiated", to: "paid", source: "return", provider_status: "COMPLETE" } },
    { ...base, id: ids[6], type: "payment.fulfilled", ts: at(38_900), order_id: order },
  ];
}
