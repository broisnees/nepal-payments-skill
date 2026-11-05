import type { EventData, PaymentStatus } from "./shared.ts";
import { Transport, type PaynpOptions } from "./client.ts";
import { messageOf, reasonOf } from "./reasons.ts";
import { baseFetch, recordingFetch } from "./trace.ts";
import { toStatus, wrapAdapterWith, wrapGatewayWith, type AdapterLike, type WrapOptions } from "./wrap.ts";

export type { PaynpOptions } from "./client.ts";
export type { AdapterLike, GatewayModule, WrapOptions } from "./wrap.ts";
export type { EventData, EventType, PaymentEvent, PaymentStatus } from "./shared.ts";
export { reasonOf } from "./reasons.ts";
export { GATEWAY_HOSTS } from "./trace.ts";
export { VERSION } from "./version.ts";

/** Any status string the blog store or the skill adapters use; mapped onto PaymentStatus. */
type StatusLike = PaymentStatus | "not_found" | "partially_refunded" | (string & {});

interface Base {
  attemptId: string;
  gateway: string;
  orderId?: string;
}

export interface StatusChange extends Base {
  from?: StatusLike;
  to: StatusLike;
  amountPaisa?: number;
  reason?: string;
  message?: string;
  source?: EventData["source"];
}
export interface Fulfilment extends Base {
  amountPaisa?: number;
}
export interface Callback extends Base {
  method?: string;
  source?: EventData["source"];
}
export interface ReconcileCheck extends Base {
  status?: StatusLike;
  providerStatus?: string;
  providerRef?: string;
  reason?: string;
}
export interface ErrorReport extends Base {
  error: unknown;
  reason?: string;
  op?: string;
}
export interface FetchContext extends Base {
  op?: string;
}

export interface Paynp {
  /**
   * False when there is no key and the SDK isn't in development (production, Workers, or `dev: false`): every
   * method below is then a no-op. Without a key in development it is true and events go to `paynp dev`.
   */
  readonly enabled: boolean;
  /** Wraps a blog-style gateway module (startPayment / confirmPayment). Returns the module itself when disabled. */
  wrapGateway<M extends object>(gateway: string, mod: M, opts?: WrapOptions): M;
  /** Wraps a skill adapter (initiate / verify). Returns the adapter itself when disabled. */
  wrapAdapter<A extends AdapterLike>(adapter: A, opts?: WrapOptions): A;
  statusChanged(e: StatusChange): void;
  fulfilled(e: Fulfilment): void;
  callbackReceived(e: Callback): void;
  reconcileChecked(e: ReconcileCheck): void;
  error(e: ErrorReport): void;
  /** A fetch that records each call as a gateway.request for one attempt. Concurrency safe. */
  fetch(ctx: FetchContext): typeof fetch;
  /** Sends everything queued. Never rejects. On serverless, pass it to ctx.waitUntil() or after(). */
  flush(): Promise<void>;
  /** Events waiting to be sent. */
  readonly queued: number;
}

export function createPaynp(opts: PaynpOptions = {}): Paynp {
  const t = new Transport(opts);
  const on = t.enabled;
  const push: Transport["push"] = (e) => t.push(e);

  return {
    enabled: on,
    get queued() {
      return t.queued;
    },
    wrapGateway: (gateway, mod, wopts) => (on ? wrapGatewayWith(t, gateway, mod, wopts) : mod),
    wrapAdapter: (adapter, wopts) => (on ? wrapAdapterWith(t, adapter, wopts) : adapter),

    statusChanged(e) {
      if (!on) return;
      const to = toStatus(e.to);
      const from = toStatus(e.from);
      push({
        type: "status.changed",
        attempt_id: e.attemptId,
        gateway: e.gateway,
        order_id: e.orderId,
        amount_paisa: e.amountPaisa,
        status: to,
        data: { from, to, reason: e.reason, message: e.message, source: e.source },
      });
    },
    fulfilled(e) {
      if (!on) return;
      push({ type: "payment.fulfilled", attempt_id: e.attemptId, gateway: e.gateway, order_id: e.orderId, amount_paisa: e.amountPaisa, status: "paid" });
    },
    callbackReceived(e) {
      if (!on) return;
      push({ type: "callback.received", attempt_id: e.attemptId, gateway: e.gateway, order_id: e.orderId, data: { method: e.method?.toUpperCase(), source: e.source ?? "return" } });
    },
    reconcileChecked(e) {
      if (!on) return;
      push({
        type: "reconcile.checked",
        attempt_id: e.attemptId,
        gateway: e.gateway,
        order_id: e.orderId,
        status: toStatus(e.status),
        data: { source: "reconcile", provider_status: e.providerStatus, provider_ref: e.providerRef, reason: e.reason },
      });
    },
    error(e) {
      if (!on) return;
      push({ type: "error", attempt_id: e.attemptId, gateway: e.gateway, order_id: e.orderId, data: { reason: e.reason ?? reasonOf(e.error), message: messageOf(e.error), op: e.op } });
    },
    fetch(ctx) {
      if (!on) return (input, init) => baseFetch()(input, init);
      let n = 0;
      return recordingFetch(baseFetch, () => (r) => {
        n++;
        const data: EventData = { op: ctx.op ?? "status", method: r.method, endpoint: r.endpoint, http_status: r.httpStatus };
        if (n > 1) data.attempt = n;
        if (r.error !== undefined) {
          data.reason = reasonOf(r.error);
          data.message = messageOf(r.error);
        }
        push({ type: "gateway.request", ts: r.ts, attempt_id: ctx.attemptId, gateway: ctx.gateway, order_id: ctx.orderId, duration_ms: r.durationMs, data });
      });
    },
    flush: () => t.flush(),
  };
}
