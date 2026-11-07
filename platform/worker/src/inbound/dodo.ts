// Dodo Payments: payments and refunds. https://docs.dodopayments.com/developer-resources/webhooks
// Deliveries are signed with Standard Webhooks (the same scheme paynp's own outbound webhooks use).
//   payment.processing    status.changed -> pending
//   payment.succeeded     status.changed -> paid
//   payment.failed        status.changed -> failed
//   payment.cancelled     status.changed -> canceled
//   refund.succeeded      payment.refunded
// Dodo sends no "created" event, so each payment also gets one payment.started at its created_at, with an id
// derived from the payment id so every later event maps onto the same one.
import type { PaymentEvent, PaymentStatus } from "@paynp/shared";
import { badRequest } from "../lib/util.ts";
import { signature } from "../webhooks/sign.ts";
import { TOLERANCE_MS, providerError, type ProviderAdapter } from "./types.ts";

export const DODO_EVENTS = ["payment.processing", "payment.succeeded", "payment.failed", "payment.cancelled", "refund.succeeded"] as const;
const BASE = { test: "https://test.dodopayments.com", live: "https://live.dodopayments.com" } as const;

const STATUS: Record<string, PaymentStatus> = {
  "payment.processing": "pending",
  "payment.succeeded": "paid",
  "payment.failed": "failed",
  "payment.cancelled": "canceled",
};

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
const iso = (v: unknown, fallback: string) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
};
const headers = (apiKey: string) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const dodo: ProviderAdapter = {
  id: "dodo",

  checkKey(apiKey) {
    // Dodo keys carry no mode prefix; the environment picks test.dodopayments.com or live.dodopayments.com.
    if (!/^[\x21-\x7e]{16,200}$/.test(apiKey)) throw badRequest("api_key must be a Dodo Payments API key");
  },

  async register(apiKey, env, url, description) {
    const res = await fetch(`${BASE[env]}/webhooks`, { method: "POST", headers: headers(apiKey), body: JSON.stringify({ url, description, filter_types: DODO_EVENTS }) });
    if (!res.ok) throw await providerError("Dodo Payments", res);
    const { id } = (await res.json()) as { id: string };
    const sec = await fetch(`${BASE[env]}/webhooks/${encodeURIComponent(id)}/secret`, { headers: headers(apiKey) });
    if (!sec.ok) {
      // Do not leave a webhook behind that paynp cannot verify.
      await fetch(`${BASE[env]}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE", headers: headers(apiKey) }).catch(() => undefined);
      throw await providerError("Dodo Payments", sec);
    }
    const { secret } = (await sec.json()) as { secret: string };
    return { id, secret };
  },

  async remove(apiKey, env, webhookId) {
    const res = await fetch(`${BASE[env]}/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE", headers: headers(apiKey) });
    if (!res.ok && res.status !== 404) throw await providerError("Dodo Payments", res);
  },

  async verify(raw, h, secret, nowMs) {
    const id = h.get("webhook-id");
    const ts = Number(h.get("webhook-timestamp"));
    const sigs = (h.get("webhook-signature") ?? "").split(" ").filter(Boolean);
    if (!id || !Number.isFinite(ts) || !sigs.length) return { ok: false, error: "missing webhook-id, webhook-timestamp or webhook-signature header" };
    if (Math.abs(nowMs - ts * 1000) > TOLERANCE_MS) return { ok: false, error: "webhook-timestamp outside the 5 minute tolerance" };
    const want = await signature(secret, id, ts, raw);
    if (!sigs.some((sig) => timingSafeEqual(sig, want))) return { ok: false, error: "Dodo signature does not match the signing secret" };
    try {
      return { ok: true, body: JSON.parse(raw), deliveryId: id };
    } catch {
      return { ok: false, error: "body is not JSON" };
    }
  },

  map(body, deliveryId) {
    const evt = o(body);
    const type = s(evt.type) ?? "";
    const d = o(evt.data);
    const ts = iso(evt.timestamp, new Date().toISOString());
    const sdk = { name: "dodo-webhook", version: "1", lang: "webhook" };

    const to = STATUS[type];
    if (to) {
      const attempt_id = s(d.payment_id);
      if (!attempt_id) return [];
      const meta = o(d.metadata);
      const customer = o(d.customer);
      const base = {
        attempt_id,
        gateway: "dodo",
        order_id: s(meta.order_id) ?? s(meta.orderId) ?? s(meta.order),
        amount_paisa: n(d.total_amount),
        currency: s(d.currency)?.toUpperCase(),
        sdk,
      };
      const started: PaymentEvent = {
        ...base,
        id: `dodo_${attempt_id}_started`,
        type: "payment.started",
        ts: iso(d.created_at, ts),
        status: "initiated",
        data: { source: "notify" },
        ...(s(customer.email) || s(customer.name) ? { customer: { email: s(customer.email), name: s(customer.name) } } : {}),
      };
      const changed: PaymentEvent = {
        ...base,
        id: `dodo_${deliveryId}`,
        type: "status.changed",
        ts,
        status: to,
        data: {
          to,
          source: "notify",
          provider_status: s(d.status),
          provider_code: s(d.error_code),
          reason: to === "failed" ? (s(d.error_code)?.toLowerCase() ?? "payment_failed") : undefined,
          message: to === "failed" ? s(d.error_message) : undefined,
        },
      };
      return [started, changed];
    }

    if (type === "refund.succeeded") {
      const refundId = s(d.refund_id);
      const attempt_id = s(d.payment_id);
      if (!refundId || !attempt_id) return [];
      return [
        {
          id: `dodo_${refundId}_refunded`,
          type: "payment.refunded",
          ts: iso(d.created_at, ts),
          attempt_id,
          gateway: "dodo",
          amount_paisa: n(d.amount),
          currency: s(d.currency)?.toUpperCase(),
          data: { source: "notify", refund_ref: refundId, refund_reason: s(d.reason) },
          sdk,
        },
      ];
    }
    return [];
  },
};
