// Realistic eSewa, Khalti and Fonepay traces for mock mode. Event shapes follow platform/SPEC.md section 3 and the
// gateway references (endpoints, provider statuses, error codes) in skills/nepal-payments/references.
import { FINAL_STATUSES, newId, type Env, type Payment, type PaymentStatus, type StoredEvent } from "@paynp/shared";

export type Rng = () => number;

export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
export const int = (r: Rng, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

export function weighted<T extends string>(r: Rng, table: Partial<Record<T, number>>): T {
  const entries = Object.entries(table) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [k, w] of entries) if ((x -= w) <= 0) return k;
  return entries[entries.length - 1][0];
}

export type Scenario =
  | "paid"
  | "paid_retry"
  | "canceled"
  | "expired"
  | "pending"
  | "amount_mismatch"
  | "bad_signature"
  | "provider_error"
  | "timeout";

const MIX: Record<string, Partial<Record<Scenario, number>>> = {
  esewa: { paid: 82, paid_retry: 3, canceled: 6, expired: 4, amount_mismatch: 1, bad_signature: 1, provider_error: 1.5, timeout: 1 },
  khalti: { paid: 81, paid_retry: 3, canceled: 8, expired: 5, provider_error: 1, timeout: 1 },
  fonepay: { paid: 80, paid_retry: 4, canceled: 6, expired: 3, bad_signature: 1, provider_error: 3, timeout: 3 },
};

export const GATEWAY_MIX = { esewa: 48, khalti: 32, fonepay: 20 } as const;

const PRICES = [150, 250, 350, 499, 650, 799, 999, 1200, 1499, 1850, 2400, 3200, 4500, 5999, 8500, 12500, 24999];

export function amount(r: Rng): number {
  const base = pick(r, PRICES) * 100;
  // A third of carts include 13% VAT, which is where paisa come from.
  return r() < 0.35 ? Math.round(base * 1.13) : base;
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randStr = (r: Rng, n: number, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");

const SDK = { name: "@paynp/sdk", version: "0.1.0", lang: "node" };

export interface TraceInput {
  r: Rng;
  start: number;
  env: Env;
  gateway: string;
  orderId: string;
  scenario?: Scenario;
  /** How long the buyer spends on the gateway page. */
  buyerMs?: number;
  /** Gateway API latency multiplier (a slow afternoon at Fonepay). */
  slow?: number;
  amountPaisa?: number;
}

/** Builds every event a payment would produce, in time order. Callers cut it at "now" for in-flight payments. */
export function trace(o: TraceInput): StoredEvent[] {
  const { r, gateway, env } = o;
  const scenario = o.scenario ?? weighted(r, MIX[gateway] ?? MIX.esewa);
  const amt = o.amountPaisa ?? amount(r);
  const slow = o.slow ?? 1;
  const start = Math.floor(o.start);
  const attempt_id = newId("att", start);
  const base = { attempt_id, order_id: o.orderId, gateway, sdk: SDK };
  const out: StoredEvent[] = [];
  let t = start;
  const lat = (lo: number, hi: number) => Math.round(between(r, lo, hi) * slow);

  const push = (type: StoredEvent["type"], extra: Partial<StoredEvent> = {}, gap = 0) => {
    t += gap;
    out.push({
      ...base,
      id: newId("evt", t),
      type,
      ts: new Date(t).toISOString(),
      received_at: t + int(r, 25, 180),
      ...extra,
    } as StoredEvent);
  };
  const req = (data: StoredEvent["data"], ms: number, gap = 3, status?: PaymentStatus) => {
    push("gateway.request", { duration_ms: ms, data, ...(status ? { status } : {}) }, gap);
    t += ms;
  };
  const settle = (from: PaymentStatus, to: PaymentStatus, data: StoredEvent["data"] = {}) =>
    push("status.changed", { status: to, data: { from, to, source: "return", ...data } }, int(r, 1, 4));

  push("payment.started", { amount_paisa: amt, status: "initiated" });

  // Initiate: Khalti is a server call that returns a pidx; eSewa and Fonepay sign a form locally.
  let ref = "";
  if (gateway === "khalti") {
    if (scenario === "provider_error") {
      req({ op: "initiate", method: "POST", endpoint: "/api/v2/epayment/initiate/", http_status: 401, provider_code: "401", reason: "invalid_key", message: "Invalid token.", attempt: 1 }, lat(180, 420), 4);
      push("error", { status: "failed", data: { reason: "invalid_key", provider_code: "401", message: "Khalti initiate failed: 401 Invalid token." } }, 2);
      settle("initiated", "failed", { reason: "invalid_key" });
      return out;
    }
    ref = randStr(r, 22, B62);
    req({ op: "initiate", method: "POST", endpoint: "/api/v2/epayment/initiate/", http_status: 200, provider_ref: ref, attempt: 1 }, lat(260, 900), 4);
  }
  if (gateway === "fonepay" && scenario === "provider_error") {
    push("payment.redirected", { data: { method: "GET", endpoint: "/api/merchantRequest" } }, int(r, 8, 30));
    push("callback.received", { data: { source: "return", method: "GET", http_status: 409, provider_code: "409", reason: "duplicate_prn", message: "Duplicate PRN" } }, int(r, 900, 2400));
    push("error", { status: "failed", data: { reason: "duplicate_prn", provider_code: "409", message: "Fonepay answered 409 Duplicate PRN: the attempt id was reused." } }, 2);
    settle("initiated", "failed", { reason: "duplicate_prn" });
    return out;
  }
  if (gateway === "esewa" && scenario === "provider_error") {
    push("payment.redirected", { data: { method: "POST", endpoint: "/api/epay/main/v2/form" } }, int(r, 8, 30));
    push("callback.received", { data: { source: "return", method: "GET", provider_code: "ES104", reason: "invalid_payload_signature", message: "ES104 Invalid payload signature." } }, int(r, 1200, 3000));
    push("error", { status: "failed", data: { reason: "invalid_payload_signature", provider_code: "ES104", message: "eSewa rejected the form: ES104 Invalid payload signature." } }, 2);
    settle("initiated", "failed", { reason: "invalid_payload_signature" });
    return out;
  }

  const formEndpoint = gateway === "esewa" ? "/api/epay/main/v2/form" : gateway === "fonepay" ? "/api/merchantRequest" : "/";
  push("payment.redirected", { data: { method: gateway === "esewa" ? "POST" : "GET", endpoint: formEndpoint } }, int(r, 10, 40));

  const buyer = o.buyerMs ?? between(r, 14_000, 95_000);

  if (scenario === "pending") {
    // Buyer left; the return URL was never hit. The row stays open until reconcile runs.
    return out;
  }

  if (scenario === "expired") {
    // No callback. Reconcile asks the gateway after the session window and gets "not found" or "Expired".
    t += 15 * 60_000 + int(r, 0, 60_000);
    const status = gateway === "khalti" ? { http_status: 400, provider_status: "Expired" } : gateway === "esewa" ? { http_status: 200, provider_status: "NOT_FOUND" } : { http_status: 200, provider_status: "failed" };
    req({ op: gateway === "khalti" ? "lookup" : "status", method: gateway === "khalti" ? "POST" : "GET", endpoint: statusEndpoint(gateway), ...status, attempt: 1 }, lat(240, 800), 0);
    push("reconcile.checked", { status: "expired", data: { source: "reconcile", provider_status: status.provider_status, reason: "session_expired" } }, 2);
    settle("initiated", "expired", { source: "reconcile", reason: "session_expired" });
    return out;
  }

  if (scenario === "canceled") {
    const ps = gateway === "khalti" ? "User canceled" : gateway === "esewa" ? "CANCELED" : "failed";
    push("callback.received", { data: { source: "return", method: "GET", provider_status: ps } }, Math.round(buyer * 0.6));
    if (gateway === "khalti") {
      req({ op: "lookup", method: "POST", endpoint: statusEndpoint(gateway), http_status: 400, provider_status: "User canceled", provider_ref: ref, attempt: 1 }, lat(220, 700));
    }
    settle("initiated", "canceled", { reason: "canceled_by_buyer", provider_status: ps });
    return out;
  }

  push("callback.received", { data: { source: "return", method: gateway === "fonepay" ? "GET" : "GET" } }, Math.round(buyer));

  if (gateway !== "khalti") {
    const valid = scenario !== "bad_signature";
    push("signature.checked", { duration_ms: int(r, 1, 4), data: valid ? { valid: true } : { valid: false, reason: "bad_signature", message: "Response signature does not match the signed fields." } }, int(r, 1, 6));
    if (!valid) {
      push("error", { status: "failed", data: { reason: "bad_signature", message: "Rejected callback: signature mismatch. Nothing was fulfilled." } }, 1);
      settle("initiated", "failed", { reason: "bad_signature" });
      return out;
    }
  }

  ref ||= gateway === "esewa" ? `000${randStr(r, 4)}` : String(int(r, 1_000_000, 9_999_999));
  const okStatus = gateway === "esewa" ? "COMPLETE" : gateway === "khalti" ? "Completed" : "success";

  if (scenario === "paid_retry" || scenario === "timeout") {
    req({ op: gateway === "khalti" ? "lookup" : "status", method: gateway === "khalti" ? "POST" : "GET", endpoint: statusEndpoint(gateway), http_status: 504, reason: "timeout", message: "Status check timed out after 10 s", attempt: 1 }, 10_000, 4);
    if (scenario === "timeout") {
      req({ op: gateway === "khalti" ? "lookup" : "status", method: gateway === "khalti" ? "POST" : "GET", endpoint: statusEndpoint(gateway), http_status: 504, reason: "timeout", message: "Status check timed out after 10 s", attempt: 2 }, 10_000, 2000);
      push("error", { status: "pending", data: { reason: "timeout", message: "Gateway did not answer the status check. Left open for reconcile." } }, 1);
      settle("initiated", "pending", { reason: "timeout" });
      return out;
    }
    t += 1000;
  }

  if (scenario === "amount_mismatch") {
    const reported = Math.round(amt * 0.88);
    req({ op: gateway === "khalti" ? "lookup" : "status", method: gateway === "khalti" ? "POST" : "GET", endpoint: statusEndpoint(gateway), http_status: 200, provider_status: okStatus, provider_ref: ref, attempt: 1 }, lat(240, 900));
    push("error", { status: "failed", data: { reason: "amount_mismatch", provider_status: okStatus, message: `Gateway reported Rs ${(reported / 100).toFixed(2)}, order total is Rs ${(amt / 100).toFixed(2)}. Not fulfilled.` } }, 1);
    settle("initiated", "failed", { reason: "amount_mismatch" });
    return out;
  }

  req({ op: gateway === "khalti" ? "lookup" : "status", method: gateway === "khalti" ? "POST" : "GET", endpoint: statusEndpoint(gateway), http_status: 200, provider_status: okStatus, provider_ref: ref, attempt: scenario === "paid_retry" ? 2 : 1 }, lat(220, 950));
  settle("initiated", "paid", { provider_ref: ref, provider_status: okStatus });
  push("payment.fulfilled", { status: "paid" }, int(r, 20, 240));
  void env;
  return out;
}

function statusEndpoint(gateway: string) {
  if (gateway === "esewa") return "/api/epay/transaction/status/";
  if (gateway === "khalti") return "/api/v2/epayment/lookup/";
  return "/api/merchant/merchantDetailsForThirdParty/txnVerification";
}

const isFinal = (s: PaymentStatus) => FINAL_STATUSES.includes(s);

/** The rollup rules from SPEC section 4, applied to one payment's events in time order. */
export function rollup(env: Env, events: StoredEvent[]): Payment {
  const first = events[0];
  const p: Payment = {
    attempt_id: first.attempt_id,
    env,
    order_id: first.order_id ?? null,
    currency: first.currency ?? "NPR",
    gateway: first.gateway,
    amount_paisa: null,
    status: "initiated",
    started_at: Date.parse(first.ts),
    updated_at: Date.parse(first.ts),
    finished_at: null,
    provider_ref: null,
    last_reason: null,
    last_message: null,
    event_count: 0,
    error_count: 0,
    fulfil_count: 0,
  };
  for (const e of events) {
    const ts = Date.parse(e.ts);
    p.event_count++;
    if (e.amount_paisa !== undefined) p.amount_paisa = e.amount_paisa;
    if (e.order_id) p.order_id = e.order_id;
    const next = e.status ?? e.data?.to;
    if (next && ts >= p.updated_at && !(isFinal(p.status) && !isFinal(next))) {
      p.status = next;
      if (isFinal(next) && p.finished_at === null) p.finished_at = ts;
    }
    p.updated_at = Math.max(p.updated_at, ts);
    if (e.data?.provider_ref) p.provider_ref = e.data.provider_ref;
    if (e.data?.reason) p.last_reason = e.data.reason;
    if (e.data?.message) p.last_message = e.data.message;
    if (e.type === "payment.fulfilled") p.fulfil_count++;
    if (e.type === "error" || (e.type === "signature.checked" && e.data?.valid === false)) p.error_count++;
  }
  return p;
}
