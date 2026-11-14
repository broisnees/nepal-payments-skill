import type { EventCustomer, EventData, PaymentStatus } from "./shared.ts";
import type { EventInput, Transport } from "./client.ts";
import { gwEnvOf, isHttps } from "./env.ts";
import { CALLBACK_REASONS, messageOf, reasonOf } from "./reasons.ts";
import { GATEWAY_HOSTS, enter, leave, now, type CallScope, type RecordedRequest } from "./trace.ts";

export interface WrapOptions {
  /**
   * Hostname suffixes the module calls, for request timing. Known gateways have defaults
   * (esewa.com.np, khalti.com, ...). An unknown gateway with no hosts gets whole-call timing.
   */
  hosts?: readonly string[];
  /** Set false to never touch globalThis.fetch; confirm calls are then timed as one request. Default true. */
  traceFetch?: boolean;
  /**
   * Who is paying, read from the startPayment / initiate input and sent on payment.started. paynp stores phone and
   * email only as a salted hash plus a masked form, so support can search by them. A throwing getter sends nothing.
   *
   * ```ts
   * paynp.wrapGateway("esewa", esewa, { customer: (input) => ({ phone: input.phone }) })
   * ```
   */
  customer?: (input: any) => CustomerInfo | null | undefined;
}

export type CustomerInfo = EventCustomer;

/** Cleans what a customer getter returned: strings only, empty fields dropped. */
export function customerOf(v: unknown): EventCustomer | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const out: EventCustomer = {};
  for (const k of ["phone", "email", "name"] as const) {
    if (typeof c[k] === "string" && (c[k] as string).trim()) out[k] = (c[k] as string).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// Callback params that carry the gateway's signature, per gateway. Present means the module
// checks a signature before it trusts anything else.
const SIGNED_PARAM: Record<string, string> = { esewa: "data", fonepay: "DV", cybersource: "signature" };

const STATUS_MAP: Record<string, PaymentStatus | undefined> = {
  initiated: "initiated",
  pending: "pending",
  paid: "paid",
  failed: "failed",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
  refunded: "refunded",
  partially_refunded: "refunded",
  unknown: "unknown",
  not_found: undefined, // no record at the gateway yet: says nothing about the attempt
};

/** Blog and adapter statuses to the event schema's PaymentStatus. */
export function toStatus(s: unknown): PaymentStatus | undefined {
  if (typeof s !== "string") return undefined;
  return Object.hasOwn(STATUS_MAP, s) ? STATUS_MAP[s] : "unknown";
}

const pathOf = (u: unknown): string | undefined => {
  if (typeof u !== "string") return undefined;
  try {
    return new URL(u).pathname;
  } catch {
    return undefined;
  }
};

const opFor = (path: string, fallback: string): string =>
  /lookup/i.test(path) ? "lookup" : /refund/i.test(path) ? "refund" : /token/i.test(path) ? "token" : fallback;

const nonEmpty = (p: unknown): p is Record<string, string> =>
  !!p && typeof p === "object" && Object.keys(p as object).length > 0;

interface Call {
  gateway: string;
  attemptId: string;
  amountPaisa?: number;
  t0: number; // epoch ms
  started: number; // now() at start
  scope: CallScope | null;
}

/** The event-building half of the wrappers, shared by wrapGateway and wrapAdapter. */
export class Recorder {
  constructor(
    private readonly transport: Transport,
    private readonly gateway: string,
    private readonly opts: WrapOptions,
  ) {}

  private hosts(): readonly string[] {
    if (this.opts.traceFetch === false) return [];
    return this.opts.hosts ?? GATEWAY_HOSTS[this.gateway] ?? [];
  }

  begin(attemptId: unknown, amountPaisa: unknown): Call | null {
    if (typeof attemptId !== "string" || !attemptId) return null; // nothing to group events by
    const t0 = Date.now();
    return {
      gateway: this.gateway,
      attemptId,
      amountPaisa: Number.isSafeInteger(amountPaisa) ? (amountPaisa as number) : undefined,
      t0,
      started: now(),
      scope: enter(this.hosts()),
    };
  }

  // Pushed in the order things happened; the transport keeps timestamps increasing per attempt.
  private push(_c: Call, e: EventInput): void {
    this.transport.push(e);
  }

  private emit(c: Call, e: Omit<EventInput, "attempt_id" | "gateway">): void {
    this.push(c, { attempt_id: c.attemptId, gateway: c.gateway, ...e });
  }

  // gateway.request events from the recorded fetches, retry numbers per endpoint.
  private requestEvents(c: Call, op: string): EventInput[] {
    const seen = new Map<string, number>();
    return (c.scope?.requests ?? []).map((r: RecordedRequest) => {
      const n = (seen.get(r.endpoint) ?? 0) + 1;
      seen.set(r.endpoint, n);
      const data: EventData = { op: opFor(r.endpoint, op), method: r.method, endpoint: r.endpoint };
      if (r.httpStatus !== undefined) data.http_status = r.httpStatus;
      const env = gwEnvOf(r.host);
      if (env) data.gw_env = env;
      if (n > 1) data.attempt = n;
      if (r.error !== undefined) {
        data.reason = reasonOf(r.error);
        data.message = messageOf(r.error);
      }
      return { type: "gateway.request", ts: r.ts, attempt_id: c.attemptId, gateway: c.gateway, duration_ms: r.durationMs, data };
    });
  }

  private traced(c: Call): boolean {
    return !!c.scope && !c.scope.ambiguous;
  }

  private errorEvent(c: Call, err: unknown, op: string): void {
    const e = err as { httpStatus?: unknown };
    const data: EventData = { reason: reasonOf(err), message: messageOf(err), op };
    if (typeof e?.httpStatus === "number") data.http_status = e.httpStatus;
    this.emit(c, { type: "error", data });
  }

  // ---- start (startPayment / initiate) ----

  startBegin(c: Call, input: unknown): void {
    const i = (input ?? {}) as { returnUrl?: unknown };
    const data: EventData = {};
    const https = isHttps(i.returnUrl);
    if (https !== undefined) data.return_https = https;
    let customer: EventCustomer | undefined;
    if (this.opts.customer) {
      try {
        customer = customerOf(this.opts.customer(input));
      } catch {
        /* a broken getter must not break checkout */
      }
    }
    this.emit(c, {
      type: "payment.started",
      ts: c.t0,
      amount_paisa: c.amountPaisa,
      status: "initiated",
      ...(Object.keys(data).length ? { data } : {}),
      ...(customer ? { customer } : {}),
    });
  }

  startEnd(c: Call, result: unknown, err?: unknown): void {
    leave(c.scope);
    if (this.traced(c)) for (const e of this.requestEvents(c, "initiate")) this.push(c, e);
    if (err !== undefined) return this.errorEvent(c, err, "initiate");
    const r = (result ?? {}) as { type?: string; kind?: string; url?: string; action?: string; providerRef?: string };
    const form = (r.type ?? r.kind) === "form";
    const target = form ? r.action : r.url;
    const data: EventData = { method: form ? "POST" : "GET", endpoint: pathOf(target) };
    if (typeof r.providerRef === "string") data.provider_ref = r.providerRef;
    const env = typeof target === "string" ? gwEnvOf(target) : undefined;
    if (env) data.gw_env = env;
    this.emit(c, { type: "payment.redirected", amount_paisa: c.amountPaisa, status: "initiated", data });
  }

  // ---- confirm (confirmPayment / verify) ----

  confirmEnd(
    c: Call,
    params: unknown,
    outcome: { status?: PaymentStatus; providerRef?: string; providerStatus?: string; reason?: string; message?: string; signatureValid?: boolean } | null,
    err?: unknown,
  ): void {
    leave(c.scope);
    const fromCallback = nonEmpty(params);
    const reason = err !== undefined ? reasonOf(err) : undefined;
    const events: EventInput[] = [];
    const base = { attempt_id: c.attemptId, gateway: c.gateway };

    if (fromCallback) events.push({ ...base, type: "callback.received", ts: c.t0, data: { source: "return" } });

    const signedParam = SIGNED_PARAM[c.gateway];
    if (fromCallback && signedParam && typeof (params as Record<string, unknown>)[signedParam] === "string") {
      // An adapter in non-strict mode reports the result instead of throwing; trust that when present.
      const valid = typeof outcome?.signatureValid === "boolean" ? outcome.signatureValid : !(reason && CALLBACK_REASONS.has(reason));
      events.push({ ...base, type: "signature.checked", ts: c.t0 + 1, data: valid ? { valid } : { valid, reason: reason ?? "bad_signature" } });
    }

    if (this.traced(c)) events.push(...this.requestEvents(c, "status"));
    else if (!(reason && CALLBACK_REASONS.has(reason))) {
      // No per-request timing possible: one gateway.request spanning the whole confirm call.
      events.push({ ...base, type: "gateway.request", ts: c.t0, duration_ms: now() - c.started, data: { op: "status" } });
    }

    if (err !== undefined) {
      for (const e of events) this.push(c, e);
      return this.errorEvent(c, err, "status");
    }

    const data: EventData = {};
    if (outcome?.providerRef) data.provider_ref = outcome.providerRef;
    if (outcome?.providerStatus) data.provider_status = outcome.providerStatus;
    if (outcome?.reason) data.reason = outcome.reason;
    if (outcome?.message) data.message = outcome.message;

    if (!fromCallback) {
      events.push({ ...base, type: "reconcile.checked", ts: Date.now(), status: outcome?.status, data: { ...data, source: "reconcile" } });
    } else {
      // The attempt's status after this confirm lands on its last event.
      const last = events[events.length - 1];
      last.status = outcome?.status;
      last.data = { ...last.data, ...data };
    }
    for (const e of events) this.push(c, e);
  }
}

type AnyFn = (...args: any[]) => any;

/** Structural shape of a blog gateway module (website/src/data/blog-code). */
export interface GatewayModule {
  startPayment?(input: { attemptId: string; amountPaisa: number }): Promise<unknown>;
  confirmPayment?(input: { attemptId: string; amountPaisa: number; providerRef?: string | null; params: Record<string, string> }): Promise<unknown>;
}

/** Structural shape of a skill adapter (skills/nepal-payments/scripts/ts/src/core/types.ts PaymentAdapter). */
export interface AdapterLike {
  readonly id: string;
  initiate(input: { orderId: string; amountPaisa: number }): Promise<unknown>;
  verify(input: { orderId: string; amountPaisa: number; providerRef?: string | null; callback?: Record<string, string> }): Promise<unknown>;
}

async function run<T>(fn: () => Promise<T>, done: (value: T | undefined, err?: unknown) => void): Promise<T> {
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    try {
      done(undefined, err === undefined ? new Error("undefined thrown") : err);
    } catch {
      /* recording must never change what the caller sees */
    }
    throw err; // the exact value the module threw
  }
  try {
    done(value);
  } catch {
    /* same */
  }
  return value;
}

// Reads nothing from `mod` until a function is called, so it works inside an import cycle
// (paynp.ts -> esewa.ts -> payments.ts -> paynp.ts) where the module is not evaluated yet.
export function wrapGatewayWith<M extends object>(transport: Transport, gateway: string, mod: M, opts: WrapOptions = {}): M {
  const rec = new Recorder(transport, gateway, opts);
  const m = mod as M & Record<string, AnyFn>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(mod)) {
    Object.defineProperty(out, k, { enumerable: true, configurable: true, get: () => (mod as Record<string, unknown>)[k] });
  }

  const startPayment = (input: { attemptId: string; amountPaisa: number }, ...rest: unknown[]) => {
    const c = rec.begin(input?.attemptId, input?.amountPaisa);
    if (!c) return m.startPayment.call(mod, input, ...rest);
    rec.startBegin(c, input);
    return run(() => m.startPayment.call(mod, input, ...rest), (v, err) => rec.startEnd(c, v, err));
  };
  const confirmPayment = (input: { attemptId: string; amountPaisa: number; params?: Record<string, string> }, ...rest: unknown[]) => {
    const c = rec.begin(input?.attemptId, input?.amountPaisa);
    if (!c) return m.confirmPayment.call(mod, input, ...rest);
    return run(
      () => m.confirmPayment.call(mod, input, ...rest),
      (v, err) => {
        const o = v as { status?: string; providerRef?: string } | undefined;
        rec.confirmEnd(c, input?.params, o ? { status: toStatus(o.status), providerRef: o.providerRef } : null, err);
      },
    );
  };
  if ("startPayment" in mod) Object.defineProperty(out, "startPayment", { enumerable: true, value: startPayment });
  if ("confirmPayment" in mod) Object.defineProperty(out, "confirmPayment", { enumerable: true, value: confirmPayment });
  return out as M;
}

// The gateway's own status text from an adapter's `raw`, which is either the status API body
// or wraps it one level down (eSewa: { status: body, signatureValid }).
function providerStatusOf(raw: unknown, depth = 0): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const k of ["status", "Status", "paymentStatus", "state", "decision"]) {
    if (typeof r[k] === "string") return r[k] as string;
    if (depth === 0 && r[k] && typeof r[k] === "object") {
      const inner = providerStatusOf(r[k], 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

export function wrapAdapterWith<A extends AdapterLike>(transport: Transport, adapter: A, opts: WrapOptions = {}): A {
  const rec = new Recorder(transport, adapter.id, opts);
  const wrapped = Object.create(adapter) as A;
  Object.defineProperty(wrapped, "initiate", {
    value: (input: Parameters<A["initiate"]>[0]) => {
      const c = rec.begin(input?.orderId, input?.amountPaisa);
      if (!c) return adapter.initiate(input);
      rec.startBegin(c, input);
      return run(() => adapter.initiate(input), (v, err) => rec.startEnd(c, v, err));
    },
  });
  Object.defineProperty(wrapped, "verify", {
    value: (input: Parameters<A["verify"]>[0]) => {
      const c = rec.begin(input?.orderId, input?.amountPaisa);
      if (!c) return adapter.verify(input);
      return run(
        () => adapter.verify(input),
        (v, err) => {
          const r = v as { status?: string; amountPaisa?: number | null; transactionId?: string | null; raw?: unknown } | undefined;
          if (!r) return rec.confirmEnd(c, input?.callback, null, err);
          let status = toStatus(r.status);
          let reason: string | undefined;
          let message: string | undefined;
          // Same rule as decideTransition(): a "paid" with the wrong amount is not paid.
          if (r.status === "paid" && r.amountPaisa !== input.amountPaisa) {
            status = "unknown";
            reason = "amount_mismatch";
            message = r.amountPaisa == null ? "provider returned no amount for a paid status" : `amount mismatch: stored ${input.amountPaisa}, provider ${r.amountPaisa}`;
          }
          rec.confirmEnd(
            c,
            input?.callback,
            {
              status,
              providerRef: r.transactionId ?? input.providerRef ?? undefined,
              providerStatus: providerStatusOf(r.raw),
              reason,
              message,
              signatureValid: (r.raw as { signatureValid?: unknown } | null)?.signatureValid === false ? false : undefined,
            },
            err,
          );
        },
      );
    },
  });
  return wrapped;
}
