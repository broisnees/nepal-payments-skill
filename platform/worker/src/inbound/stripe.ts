// Stripe: PaymentIntents and Refunds. https://docs.stripe.com/webhooks
//   payment_intent.created            payment.started
//   payment_intent.processing         status.changed -> pending
//   payment_intent.requires_action    status.changed -> pending (3-D Secure, bank redirect)
//   payment_intent.succeeded          status.changed -> paid
//   payment_intent.payment_failed     status.changed -> failed (the intent can still succeed on a later try)
//   payment_intent.canceled           status.changed -> canceled
//   refund.created / refund.updated   payment.refunded once the refund has succeeded
// The attempt is the PaymentIntent id. Ids are derived from Stripe's, so retries and replays dedupe in ingest.
import type { PaymentEvent, PaymentStatus } from "@paynp/shared";
import { badRequest } from "../lib/util.ts";
import { TOLERANCE_MS, providerError, type ProviderAdapter } from "./types.ts";

const API = "https://api.stripe.com/v1";
export const STRIPE_EVENTS = [
  "payment_intent.created",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "refund.created",
  "refund.updated",
] as const;

const PI_STATUS: Record<string, PaymentStatus> = {
  "payment_intent.processing": "pending",
  "payment_intent.requires_action": "pending",
  "payment_intent.succeeded": "paid",
  "payment_intent.payment_failed": "failed",
  "payment_intent.canceled": "canceled",
};

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Signs like Stripe does; exported for tests. */
export async function stripeSignatureHeader(secret: string, body: string, tSec: number): Promise<string> {
  return `t=${tSec},v1=${await hmacHex(secret, `${tSec}.${body}`)}`;
}

const auth = (apiKey: string) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/x-www-form-urlencoded" });

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
const iso = (sec: unknown, fallback: string) => (typeof sec === "number" ? new Date(sec * 1000).toISOString() : fallback);
const orderOf = (meta: Obj) => s(meta.order_id) ?? s(meta.orderId) ?? s(meta.order);

export const stripe: ProviderAdapter = {
  id: "stripe",

  checkKey(apiKey, env) {
    const m = /^(sk|rk)_(test|live)_[0-9A-Za-z]{10,}$/.exec(apiKey);
    if (!m) throw badRequest("api_key must be a Stripe secret key (sk_...) or restricted key (rk_...)");
    if (m[2] !== env) throw badRequest(`this is a ${m[2]}-mode Stripe key; use a ${env}-mode key for the ${env} environment`);
  },

  async register(apiKey, _env, url, description) {
    const form = new URLSearchParams({ url, description });
    for (const e of STRIPE_EVENTS) form.append("enabled_events[]", e);
    const res = await fetch(`${API}/webhook_endpoints`, { method: "POST", headers: auth(apiKey), body: form });
    if (!res.ok) throw await providerError("Stripe", res);
    const j = (await res.json()) as { id: string; secret: string };
    return { id: j.id, secret: j.secret };
  },

  async remove(apiKey, _env, webhookId) {
    const res = await fetch(`${API}/webhook_endpoints/${encodeURIComponent(webhookId)}`, { method: "DELETE", headers: auth(apiKey) });
    if (!res.ok && res.status !== 404) throw await providerError("Stripe", res);
  },

  async verify(raw, headers, secret, nowMs) {
    const header = headers.get("stripe-signature");
    if (!header) return { ok: false, error: "missing Stripe-Signature header" };
    const parts = header.split(",").map((p) => p.split("="));
    const t = Number(parts.find(([k]) => k === "t")?.[1]);
    const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
    if (!Number.isFinite(t) || !sigs.length) return { ok: false, error: "malformed Stripe-Signature header" };
    if (Math.abs(nowMs - t * 1000) > TOLERANCE_MS) return { ok: false, error: "Stripe-Signature timestamp outside the 5 minute tolerance" };
    const want = await hmacHex(secret, `${t}.${raw}`);
    if (!sigs.some((sig) => timingSafeEqual(sig, want))) return { ok: false, error: "Stripe signature does not match the signing secret" };
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, error: "body is not JSON" };
    }
    const id = s(o(body).id);
    if (!id) return { ok: false, error: "event has no id" };
    return { ok: true, body, deliveryId: id };
  },

  map(body, deliveryId) {
    const evt = o(body);
    const type = s(evt.type) ?? "";
    const obj = o(o(evt.data).object);
    const ts = iso(evt.created, new Date().toISOString());
    const gw_env = evt.livemode === true ? ("production" as const) : ("sandbox" as const);
    const sdk = { name: "stripe-webhook", version: s(evt.api_version) ?? "unknown", lang: "webhook" };

    if (type.startsWith("payment_intent.")) {
      const pi = obj;
      const attempt_id = s(pi.id);
      if (!attempt_id) return [];
      const meta = o(pi.metadata);
      const base = {
        attempt_id,
        gateway: "stripe",
        order_id: orderOf(meta),
        amount_paisa: n(pi.amount),
        currency: s(pi.currency)?.toUpperCase(),
        sdk,
      };
      const email = s(pi.receipt_email);
      // Every intent gets one payment.started at its creation time, whichever event arrives first; the derived id
      // makes payment_intent.created and the fallback the same event.
      const started: PaymentEvent = {
        ...base,
        id: `stripe_${attempt_id}_started`,
        type: "payment.started",
        ts: iso(pi.created, ts),
        status: "initiated",
        data: { source: "notify", gw_env },
        ...(email ? { customer: { email } } : {}),
      };
      const to = PI_STATUS[type];
      if (!to) return type === "payment_intent.created" ? [started] : [];
      const err = o(pi.last_payment_error);
      const reason = to === "failed" ? (s(err.decline_code) ?? s(err.code) ?? "payment_failed") : type === "payment_intent.requires_action" ? "requires_action" : undefined;
      const changed: PaymentEvent = {
        ...base,
        id: `stripe_${deliveryId}`,
        type: "status.changed",
        ts,
        status: to,
        data: {
          to,
          source: "notify",
          provider_status: s(pi.status),
          provider_ref: s(pi.latest_charge) ?? (typeof pi.latest_charge === "object" ? s(o(pi.latest_charge).id) : undefined),
          provider_code: s(err.code),
          reason,
          message: to === "failed" ? s(err.message) : undefined,
          gw_env,
        },
      };
      return [started, changed];
    }

    if (type === "refund.created" || type === "refund.updated") {
      const r = obj;
      const refundId = s(r.id);
      const attempt_id = s(r.payment_intent) ?? (typeof r.payment_intent === "object" ? s(o(r.payment_intent).id) : undefined);
      // Only a succeeded refund moves money; created and updated can both report it, so the id is the refund's.
      if (!refundId || !attempt_id || r.status !== "succeeded") return [];
      return [
        {
          id: `stripe_${refundId}_refunded`,
          type: "payment.refunded",
          ts: iso(r.created, ts),
          attempt_id,
          gateway: "stripe",
          amount_paisa: n(r.amount),
          currency: s(r.currency)?.toUpperCase(),
          data: { source: "notify", refund_ref: refundId, refund_reason: s(r.reason), gw_env },
          sdk,
        },
      ];
    }
    return [];
  },
};
