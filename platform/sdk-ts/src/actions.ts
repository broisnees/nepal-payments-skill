// Signed actions from paynp to the merchant's own server (SPEC-v2 section 3): refunds and re-checks run here, with
// the merchant's own gateway keys, never on paynp. Verifies X-Paynp-Signature, rejects stale timestamps and replays,
// calls the merchant's callback, reports payment.refunded, and answers with the JSON paynp expects.
//
// WebCrypto only (crypto.subtle), so it runs on Node 20+, Bun, Deno and Workers.

import type { EventInput } from "./client.ts";
import type { PaymentStatus } from "./shared.ts";
import { toStatus } from "./wrap.ts";

type StatusLike = PaymentStatus | "not_found" | "partially_refunded" | (string & {});

/** One action as the merchant's callback sees it. */
export interface PaynpAction {
  /** `act_...`, unique per action. */
  id: string;
  kind: "refund" | "recheck";
  attemptId: string;
  gateway: string;
  orderId?: string;
  /** The payment's amount. */
  amountPaisa?: number;
  /** The gateway's reference for the payment (Khalti transaction_id, eSewa ref_id, ...). */
  providerRef?: string;
  /** Refund only. `amountPaisa` missing means a full refund. */
  refund?: { amountPaisa?: number; reason?: string };
}

export interface RefundResult {
  /** The gateway's refund reference, if it gave one. Shown on the refund case. */
  refundRef?: string;
  /** What was refunded, if it differs from what paynp asked for. */
  amountPaisa?: number;
  status?: StatusLike;
}
export interface RecheckResult {
  status?: StatusLike;
  providerRef?: string;
  providerStatus?: string;
}
/** A callback can also report a failure without throwing. */
export interface ActionFailure {
  ok: false;
  error: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface ActionHandlerOptions {
  /** Refund the payment through the gateway. Throw (or return `{ ok: false, error }`) when it didn't work. */
  refund?: (action: PaynpAction) => MaybePromise<RefundResult | ActionFailure | void>;
  /** Ask the gateway for the payment's status again, usually `confirmPayment` with empty params. */
  recheck?: (action: PaynpAction) => MaybePromise<RecheckResult | ActionFailure | void>;
  /** The action secret from the dashboard. Default: PAYNP_ACTION_SECRET from the environment. On Workers, pass `env.PAYNP_ACTION_SECRET`. */
  secret?: string;
  /** How old (or how far in the future) a timestamp may be, in seconds. Default 300. */
  toleranceSec?: number;
  /** Clock override for tests, in ms. */
  now?: () => number;
}

export interface ActionResponse {
  status: number;
  body: { ok: true; refund_ref?: string; status?: PaymentStatus } | { ok: false; error: string };
}

const MAX_BODY = 64 * 1024;
const SEEN_CAP = 10_000;
const FLUSH_WAIT_MS = 3000;

function envVar(name: string): string | undefined {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;
  } catch {
    return undefined;
  }
}

const enc = new TextEncoder();

/** Lowercase hex HMAC-SHA256 of `message` with `secret`. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let out = "";
  for (const b of sig) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Headers paynp sends with an action. Exported for tests and for anyone signing a test request by hand. */
export async function signAction(secret: string, body: string, timestampSec: number): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-paynp-timestamp": String(timestampSec),
    "x-paynp-signature": `sha256=${await hmacHex(secret, `${timestampSec}.${body}`)}`,
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const fail = (status: number, error: string): ActionResponse => ({ status, body: { ok: false, error } });

/** The dashboard's "Test" button sends kind "ping": signature checked, nothing else runs. */
const PING = "ping";

function parseAction(body: string): PaynpAction | typeof PING | string {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return "body is not JSON";
  }
  if (!j || typeof j !== "object") return "body is not an object";
  const str = (k: string) => (typeof j[k] === "string" && j[k] !== "" ? (j[k] as string) : undefined);
  const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
  const id = str("id");
  const kind = str("kind");
  const attemptId = str("attempt_id");
  const gateway = str("gateway");
  if (!id) return "id is required";
  if (kind === PING) return PING;
  if (kind !== "refund" && kind !== "recheck") return `unknown kind: ${String(j.kind)}`;
  if (!attemptId || !gateway) return "attempt_id and gateway are required";
  const action: PaynpAction = { id, kind, attemptId, gateway };
  const orderId = str("order_id");
  if (orderId) action.orderId = orderId;
  const amount = int(j.amount_paisa);
  if (amount !== undefined) action.amountPaisa = amount;
  const providerRef = str("provider_ref");
  if (providerRef) action.providerRef = providerRef;
  if (kind === "refund") {
    const r = (j.refund && typeof j.refund === "object" ? j.refund : {}) as Record<string, unknown>;
    action.refund = {};
    const ra = int(r.amount_paisa);
    if (ra !== undefined) action.refund.amountPaisa = ra;
    if (typeof r.reason === "string" && r.reason) action.refund.reason = r.reason;
  }
  return action;
}

const isFailure = (v: unknown): v is ActionFailure => !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;

const errorText = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "the action callback threw";
};

/** The verify-and-dispatch core behind actionHandler() and nodeActionHandler(). One per paynp instance. */
export class ActionCore {
  // Action ids already handled (or in flight), oldest first. An id only needs remembering for the timestamp window,
  // since anything older is rejected on its timestamp alone.
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly push: (e: EventInput) => void,
    private readonly flush: () => Promise<void>,
  ) {}

  async handle(opts: ActionHandlerOptions, method: string, header: (name: string) => string | undefined, body: string): Promise<ActionResponse> {
    if (method.toUpperCase() !== "POST") return fail(405, "use POST");
    const secret = opts.secret ?? envVar("PAYNP_ACTION_SECRET");
    if (!secret) return fail(500, "PAYNP_ACTION_SECRET is not set on this server");
    if (body.length > MAX_BODY) return fail(413, "body too large");

    const tsRaw = header("x-paynp-timestamp");
    const sigRaw = header("x-paynp-signature");
    if (!tsRaw || !sigRaw) return fail(401, "missing X-Paynp-Signature or X-Paynp-Timestamp");
    if (!/^\d{1,12}$/.test(tsRaw.trim())) return fail(401, "bad timestamp");
    const expected = `sha256=${await hmacHex(secret, `${tsRaw.trim()}.${body}`)}`;
    if (!safeEqual(sigRaw.trim().toLowerCase(), expected)) return fail(401, "bad signature");

    const nowMs = (opts.now ?? Date.now)();
    const tolerance = (opts.toleranceSec ?? 300) * 1000;
    if (Math.abs(nowMs - Number(tsRaw.trim()) * 1000) > tolerance) return fail(401, "timestamp outside the 5 minute window");

    const action = parseAction(body);
    if (action === PING) return { status: 200, body: { ok: true } };
    if (typeof action === "string") return fail(400, action);

    this.forget(nowMs - tolerance * 2);
    if (this.seen.has(action.id)) return fail(409, "action already handled");
    this.seen.set(action.id, nowMs);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.keys().next().value!);

    const res = action.kind === "refund" ? await this.refund(opts, action) : await this.recheck(opts, action);
    // On serverless the function may freeze after the response: send the events first, but never hold the answer long.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.flush(), new Promise((r) => (timer = setTimeout(r, FLUSH_WAIT_MS)))]);
    if (timer !== undefined) clearTimeout(timer);
    return res;
  }

  private forget(before: number): void {
    for (const [id, at] of this.seen) {
      if (at >= before) break;
      this.seen.delete(id);
    }
  }

  private async refund(opts: ActionHandlerOptions, a: PaynpAction): Promise<ActionResponse> {
    if (!opts.refund) return fail(200, "this server has no refund handler; refund by hand from the gateway's merchant portal");
    let result: RefundResult | ActionFailure | void;
    try {
      result = await opts.refund(a);
    } catch (err) {
      return fail(200, errorText(err));
    }
    if (isFailure(result)) return fail(200, String(result.error || "refund failed"));
    const r = (result ?? {}) as RefundResult;
    const amount = Number.isSafeInteger(r.amountPaisa) ? r.amountPaisa : (a.refund?.amountPaisa ?? a.amountPaisa);
    this.push({
      type: "payment.refunded",
      attempt_id: a.attemptId,
      gateway: a.gateway,
      order_id: a.orderId,
      amount_paisa: amount,
      data: { refund_ref: r.refundRef, refund_reason: a.refund?.reason, action_id: a.id, provider_ref: a.providerRef },
    });
    const body: ActionResponse["body"] = { ok: true };
    if (typeof r.refundRef === "string" && r.refundRef) body.refund_ref = r.refundRef;
    const status = toStatus(r.status);
    if (status) body.status = status;
    return { status: 200, body };
  }

  private async recheck(opts: ActionHandlerOptions, a: PaynpAction): Promise<ActionResponse> {
    if (!opts.recheck) return fail(200, "this server has no recheck handler");
    let result: RecheckResult | ActionFailure | void;
    try {
      result = await opts.recheck(a);
    } catch (err) {
      return fail(200, errorText(err));
    }
    if (isFailure(result)) return fail(200, String(result.error || "recheck failed"));
    const r = (result ?? {}) as RecheckResult;
    const status = toStatus(r.status);
    this.push({
      type: "reconcile.checked",
      attempt_id: a.attemptId,
      gateway: a.gateway,
      order_id: a.orderId,
      status,
      data: { source: "manual", action_id: a.id, provider_ref: r.providerRef, provider_status: r.providerStatus },
    });
    const body: ActionResponse["body"] = { ok: true };
    if (status) body.status = status;
    return { status: 200, body };
  }
}

// ---- runtime adapters ----

/** Fetch API: Hono, Next.js route handlers, Workers, Bun.serve, Deno.serve. */
export function fetchHandler(core: ActionCore, opts: ActionHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = request.method.toUpperCase() === "POST" ? await request.text() : "";
    const r = await core.handle(opts, request.method, (n) => request.headers.get(n) ?? undefined, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}

/** The parts of a Node, Express or Fastify request the handler reads. */
export interface NodeLikeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  on?: (event: string, cb: (chunk?: unknown) => void) => unknown;
  readableEnded?: boolean;
}
/** Node's ServerResponse / Express `res`, or a Fastify `reply`. */
export interface NodeLikeResponse {
  statusCode?: number;
  setHeader?: (name: string, value: string) => unknown;
  end?: (body: string) => unknown;
  code?: (status: number) => NodeLikeResponse;
  header?: (name: string, value: string) => NodeLikeResponse;
  send?: (body: string) => unknown;
  raw?: unknown;
}

const dec = new TextDecoder();

function bytesToString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return dec.decode(v); // Buffer is a Uint8Array
  if (v instanceof ArrayBuffer) return dec.decode(new Uint8Array(v));
  return undefined;
}

function readStream(req: NodeLikeRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on!("data", (c) => {
      const b = typeof c === "string" ? enc.encode(c) : (c as Uint8Array);
      size += b.length;
      if (size <= MAX_BODY + 1) chunks.push(b);
    });
    req.on!("end", () => {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      resolve(dec.decode(all));
    });
    req.on!("error", (e) => reject(e));
  });
}

/**
 * The exact bytes paynp signed. Best: a raw body (express.raw(), Fastify rawBody, or mounting before any body
 * parser). A body that a JSON parser already turned into an object is serialized again, which matches what paynp
 * sent because paynp sends compact JSON.stringify output.
 */
async function nodeBody(req: NodeLikeRequest): Promise<string> {
  const raw = bytesToString(req.rawBody);
  if (raw !== undefined) return raw;
  const b = bytesToString(req.body);
  if (b !== undefined) return b;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  if (typeof req.on === "function" && !req.readableEnded) return readStream(req);
  return "";
}

export function nodeHandler(core: ActionCore, opts: ActionHandlerOptions): (req: NodeLikeRequest, res: NodeLikeResponse) => Promise<void> {
  return async (req, res) => {
    let r: ActionResponse;
    try {
      const method = req.method ?? "POST";
      const body = method.toUpperCase() === "POST" ? await nodeBody(req) : "";
      const header = (n: string) => {
        const v = req.headers[n] ?? req.headers[n.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      };
      r = await core.handle(opts, method, header, body);
    } catch (err) {
      r = fail(500, errorText(err));
    }
    const json = JSON.stringify(r.body);
    if (typeof res.code === "function" && typeof res.send === "function" && res.raw !== undefined) {
      // Fastify reply. Sent before the handler's promise settles, so an async route may resolve with nothing.
      const reply = res.code(r.status);
      reply.header?.("content-type", "application/json");
      reply.send!(json);
      return;
    }
    res.statusCode = r.status;
    res.setHeader?.("content-type", "application/json");
    res.end?.(json);
  };
}
