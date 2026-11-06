// Sample payments for the landing page's product panel. Made up, labelled as sample on the page, and shaped exactly
// like the API's Payment and StoredEvent so the real dashboard components render them.
import type { Payment, PaymentStatus, StoredEvent } from "@paynp/shared";

export interface Sample {
  payment: Payment;
  events: StoredEvent[];
}

type Step = Omit<StoredEvent, "id" | "ts" | "attempt_id" | "gateway" | "received_at"> & { at: number };

const S = 1000;
const M = 60 * S;

function build(n: number, gateway: string, order: string, amount: number, status: PaymentStatus, startedAgo: number, now: number, steps: Step[]): Sample {
  const attempt = `att_${gateway.slice(0, 3)}${(9_340_000 + n * 7_919).toString(36)}`;
  const t0 = now - startedAgo;
  const events: StoredEvent[] = steps.map((s, i) => {
    const { at, ...rest } = s;
    const ts = t0 + at;
    return { ...rest, id: `evt_sample_${n}_${i}`, ts: new Date(ts).toISOString(), attempt_id: attempt, gateway, order_id: order, received_at: ts + 180 + i * 7 };
  });
  const last = Math.max(...steps.map((s) => s.at + (s.duration_ms ?? 0)));
  const final = status !== "initiated" && status !== "pending" && status !== "unknown";
  const withReason = [...events].reverse().find((e) => e.data?.reason || e.data?.provider_status);
  return {
    payment: {
      attempt_id: attempt,
      env: "live",
      order_id: order,
      gateway,
      amount_paisa: amount,
      status,
      started_at: t0,
      updated_at: t0 + last,
      finished_at: final ? t0 + last : null,
      provider_ref: events.find((e) => e.data?.provider_ref)?.data?.provider_ref ?? null,
      last_reason: withReason?.data?.reason ?? null,
      last_message: withReason?.data?.message ?? null,
      event_count: events.length,
      error_count: events.filter((e) => e.type === "error" || (e.type === "signature.checked" && e.data?.valid === false)).length,
      fulfil_count: events.filter((e) => e.type === "payment.fulfilled").length,
      gw_env: "production",
    },
    events,
  };
}

/** Six recent payments, newest first. Times are relative to `now` so the page always reads as recent. */
export function samplePayments(now: number): Sample[] {
  return [
    build(1, "esewa", "HT-10491", 245_000, "paid", 2 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 245_000, data: { return_https: true } },
      { type: "payment.redirected", at: 140, data: { method: "POST", endpoint: "/api/epay/main/v2/form", gw_env: "production" } },
      { type: "callback.received", at: 38_420, data: { method: "GET", source: "return", provider_status: "COMPLETE" } },
      { type: "signature.checked", at: 38_431, duration_ms: 2, data: { valid: true } },
      { type: "gateway.request", at: 38_440, duration_ms: 412, data: { op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200, provider_status: "COMPLETE", provider_ref: "0LD5CEH", gw_env: "production" } },
      { type: "status.changed", at: 38_870, status: "paid", data: { from: "initiated", to: "paid", provider_status: "COMPLETE" } },
      { type: "payment.fulfilled", at: 38_910 },
    ]),
    build(2, "khalti", "HT-10490", 120_000, "expired", 41 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 120_000, data: { return_https: true } },
      { type: "gateway.request", at: 20, duration_ms: 640, data: { op: "initiate", method: "POST", endpoint: "/api/v2/epayment/initiate/", http_status: 200, provider_ref: "bZQLD9wRVWo4CdESSfuSsB", gw_env: "production" } },
      { type: "payment.redirected", at: 680, data: { method: "GET", gw_env: "production" } },
      { type: "gateway.request", at: 32 * M, duration_ms: 380, data: { op: "lookup", method: "POST", endpoint: "/api/v2/epayment/lookup/", http_status: 400, provider_status: "Expired", source: "reconcile", gw_env: "production" } },
      { type: "reconcile.checked", at: 32 * M + 400, status: "expired", data: { provider_status: "Expired", source: "reconcile" } },
    ]),
    build(3, "fonepay", "HT-10489", 560_000, "paid", 53 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 560_000, data: { return_https: true } },
      { type: "payment.redirected", at: 90, data: { method: "GET", endpoint: "/api/merchantRequest", gw_env: "production" } },
      { type: "callback.received", at: 61_200, data: { method: "GET", source: "return", provider_status: "success" } },
      { type: "signature.checked", at: 61_206, duration_ms: 1, data: { valid: true } },
      { type: "gateway.request", at: 61_210, duration_ms: 905, data: { op: "status", method: "GET", http_status: 200, provider_ref: "FP-8812044", gw_env: "production" } },
      { type: "status.changed", at: 62_130, status: "paid", data: { from: "initiated", to: "paid" } },
      { type: "payment.fulfilled", at: 62_190 },
    ]),
    build(4, "esewa", "HT-10488", 89_900, "failed", 67 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 89_900, data: { return_https: true } },
      { type: "payment.redirected", at: 110, data: { method: "POST", endpoint: "/api/epay/main/v2/form", gw_env: "production" } },
      { type: "callback.received", at: 4_210, data: { method: "GET", source: "return", provider_code: "ES104" } },
      { type: "error", at: 4_230, data: { reason: "bad_signature", provider_code: "ES104", message: "eSewa: ES104 Invalid payload signature" } },
      { type: "status.changed", at: 4_260, status: "failed", data: { from: "initiated", to: "failed", provider_code: "ES104" } },
    ]),
    build(5, "nps", "HT-10487", 1_250_000, "pending", 6 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 1_250_000, data: { return_https: true } },
      { type: "gateway.request", at: 30, duration_ms: 1_180, data: { op: "initiate", method: "POST", http_status: 200, gw_env: "production" } },
      { type: "payment.redirected", at: 1_240, data: { method: "POST", gw_env: "production" } },
      { type: "callback.received", at: 94_000, data: { method: "GET", source: "return", provider_status: "Pending" } },
      { type: "gateway.request", at: 94_020, duration_ms: 2_340, data: { op: "status", method: "POST", http_status: 200, provider_status: "Pending", gw_env: "production" } },
      { type: "status.changed", at: 96_400, status: "pending", data: { from: "initiated", to: "pending", provider_status: "Pending" } },
    ]),
    build(6, "connectips", "HT-10486", 330_000, "paid", 88 * M, now, [
      { type: "payment.started", at: 0, status: "initiated", amount_paisa: 330_000, data: { return_https: true } },
      { type: "payment.redirected", at: 160, data: { method: "POST", gw_env: "production" } },
      { type: "callback.received", at: 47_800, data: { method: "GET", source: "return" } },
      { type: "gateway.request", at: 47_820, duration_ms: 1_460, data: { op: "status", method: "POST", http_status: 200, provider_status: "SUCCESS", gw_env: "production" } },
      { type: "status.changed", at: 49_300, status: "paid", data: { from: "initiated", to: "paid", provider_status: "SUCCESS" } },
      { type: "payment.fulfilled", at: 49_350 },
    ]),
  ];
}
