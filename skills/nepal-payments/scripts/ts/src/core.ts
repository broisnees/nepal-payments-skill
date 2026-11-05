/**
 * Shared primitives for every provider adapter.
 *
 * Runtime: anything with WebCrypto + fetch (Node >= 18, Bun, Deno,
 * Cloudflare Workers, Vercel/Next.js edge). Zero dependencies.
 */

export type ProviderId =
  | "esewa"
  | "khalti"
  | "fonepay"
  | "connectips"
  | "cybersource"
  | "nps"
  | "imepay";

/** Normalized payment state. Map every provider status onto exactly one of these. */
export type PaymentStatus =
  | "paid" // money captured; safe to fulfil
  | "pending" // provider has not settled yet; re-check later, do NOT fulfil
  | "failed" // declined / error; safe to let the user retry with a NEW order id
  | "canceled" // user backed out
  | "expired" // session timed out before payment
  | "refunded"
  | "partially_refunded"
  | "not_found" // provider has no record (never started, or wrong env/credentials)
  | "unknown"; // anything unmapped; treat like pending and alert

export interface VerifyResult {
  provider: ProviderId;
  status: PaymentStatus;
  /** Your order / transaction id as known to the provider. */
  orderId: string;
  /** Amount the PROVIDER says was paid, in paisa (1 NPR = 100 paisa). null if the provider doesn't say. */
  amountPaisa: number | null;
  /** Provider's final transaction id (eSewa ref_id, Khalti transaction_id, ...). Store it; support and refunds need it. */
  transactionId: string | null;
  /** Untouched provider response, for audit logs. */
  raw: unknown;
}

export type InitiateResult =
  /**
   * Redirect the browser (or open a WebView / Custom Tab) to `url`.
   * `providerRef` (e.g. Khalti pidx, NPS ProcessId) MUST be persisted on the attempt; verify() needs it.
   */
  | { kind: "redirect"; url: string; providerRef?: string; expiresAt?: string; raw?: unknown }
  /** Render an auto-submitting HTML form that POSTs `fields` to `action`. */
  | {
      kind: "form";
      action: string;
      method: "POST";
      fields: Record<string, string>;
      /** Default application/x-www-form-urlencoded. NPS requires multipart/form-data. */
      enctype?: "multipart/form-data";
      providerRef?: string;
    };

export interface Customer {
  name?: string;
  email?: string;
  phone?: string;
}

export interface InitiateInput {
  /** Unique per payment ATTEMPT (not per order). Provider-safe charset: [A-Za-z0-9-]. */
  orderId: string;
  /** Integer paisa, computed server-side from your order. */
  amountPaisa: number;
  /** Shown to the payer where the provider supports it. */
  description: string;
  /** Where the provider sends the payer back (your server route). */
  returnUrl: string;
  /** Some providers have a separate failure URL; defaults to returnUrl. */
  failureUrl?: string;
  customer?: Customer;
}

export interface VerifyInput {
  orderId: string;
  /** The amount YOU stored for this attempt. */
  amountPaisa: number;
  /** The providerRef returned by initiate() (Khalti pidx, NPS ProcessId, IME Pay TokenId...), from YOUR db. */
  providerRef?: string | null;
  /** Raw query/body params the provider sent to your return URL, if any. */
  callback?: Record<string, string>;
}

export interface PaymentAdapter {
  readonly id: ProviderId;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Server-to-server confirmation. Never trust callback params alone. */
  verify(input: VerifyInput): Promise<VerifyResult>;
  /** Extract YOUR order id from return-URL params so you can load the attempt. */
  orderIdFromCallback(params: Record<string, string>): string | null;
}

/** Status as stored on a payment attempt row ("initiated" = created, provider not yet heard from). */
export type AttemptStatus = PaymentStatus | "initiated";
export const OPEN_STATUSES: readonly AttemptStatus[] = ["initiated", "pending", "unknown"];
const CLOSED_UNPAID: readonly AttemptStatus[] = ["failed", "canceled", "expired", "not_found"];

export interface TransitionDecision {
  /** Status to write, or null to write nothing. */
  next: AttemptStatus | null;
  /** Stop automation and alert a human (amount mismatch / provider gave no amount for a "paid"). */
  reviewRequired: boolean;
  /** Provider says paid after we had closed the attempt: recover + alert. */
  latePaid: boolean;
  reason: string;
}

/**
 * Pure state-machine decision for a verify() result (references/architecture.md §2, §4).
 * Apply `next` with a conditional UPDATE guarded by `prev`, and fulfil only if next === "paid".
 * Refund transitions (paid -> refunded) come from your refund flow, not from here.
 */
export function decideTransition(
  prev: AttemptStatus,
  result: Pick<VerifyResult, "status" | "amountPaisa">,
  storedAmountPaisa: number,
  attemptAgeMs: number,
  sessionWindowMs = 60 * 60_000,
): TransitionDecision {
  const latePaid = result.status === "paid" && CLOSED_UNPAID.includes(prev);
  if (!OPEN_STATUSES.includes(prev) && !latePaid) return { next: null, reviewRequired: false, latePaid: false, reason: `attempt already ${prev}` };
  if (result.status === "paid" && result.amountPaisa !== storedAmountPaisa) {
    return {
      next: "unknown",
      reviewRequired: true,
      latePaid,
      reason: result.amountPaisa === null ? "provider returned no amount for a paid status" : `amount mismatch: stored ${storedAmountPaisa}, provider ${result.amountPaisa}`,
    };
  }
  let next: AttemptStatus = result.status;
  if (next === "not_found") {
    // Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
    if (attemptAgeMs < sessionWindowMs) return { next: null, reviewRequired: false, latePaid: false, reason: "not_found inside session window" };
    next = "expired";
  }
  if (next === prev) return { next: null, reviewRequired: false, latePaid: false, reason: "unchanged" };
  return { next, reviewRequired: false, latePaid, reason: latePaid ? `late payment (was ${prev})` : `${prev} -> ${next}` };
}

export class PaymentError extends Error {
  readonly provider: ProviderId;
  readonly code: string;
  readonly httpStatus?: number;
  readonly details?: unknown;
  constructor(message: string, provider: ProviderId, code: string, httpStatus?: number, details?: unknown) {
    super(message);
    this.name = "PaymentError";
    this.provider = provider;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Money. Keep money as integer paisa everywhere; convert only at the edge.
// ---------------------------------------------------------------------------

export function assertPaisa(paisa: number, provider: ProviderId): void {
  if (!Number.isSafeInteger(paisa) || paisa <= 0) {
    throw new PaymentError(`amount must be a positive integer in paisa, got ${paisa}`, provider, "invalid_amount");
  }
}

/** 12345 -> "123.45", 10000 -> "100". Never use floats for money. */
export function paisaToRupees(paisa: number): string {
  const sign = paisa < 0 ? "-" : ""; // Math.trunc(-5 / 100) is -0, which prints as "0"
  const abs = Math.abs(paisa);
  const rupees = Math.trunc(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}${rupees}` : `${sign}${rupees}.${String(rem).padStart(2, "0")}`;
}

/** "123.45" | 123.45 | "100" -> paisa integer. Rounds half away from zero on the 3rd decimal. */
export function rupeesToPaisa(rupees: string | number): number {
  const s = typeof rupees === "number" ? String(rupees) : rupees.trim().replace(/,/g, ""); // String(1.005) = "1.005" (toFixed would round in binary)
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a rupee amount: ${rupees}`);
  const [whole, frac = ""] = s.split(".");
  const neg = whole.startsWith("-");
  const w = BigInt(whole.replace("-", ""));
  const f = (frac + "000").slice(0, 3);
  let p = w * 100n + BigInt(f.slice(0, 2));
  if (Number(f[2]) >= 5) p += 1n;
  return Number(neg ? -p : p);
}

// ---------------------------------------------------------------------------
// Encoding + crypto (WebCrypto).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Tolerates url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers. */
export function fromBase64(b64: string): Uint8Array {
  // Spaces back to "+" BEFORE trimming, or a leading/trailing "+" is lost.
  let s = b64.replace(/ /g, "+").trim().replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const base64Json = (b64: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64(b64)));

/** Own-property lookup, so keys like "constructor" or "__proto__" never reach Object.prototype. */
export const lookup = <V>(table: Record<string, V>, key: string): V | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export async function hmac(
  hash: "SHA-256" | "SHA-512",
  key: string | Uint8Array,
  message: string | Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle.importKey(
    "raw",
    (typeof key === "string" ? utf8(key) : key) as BufferSource,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", k, (typeof message === "string" ? utf8(message) : message) as BufferSource));
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", (typeof data === "string" ? utf8(data) : data) as BufferSource));
}

/**
 * RSA PKCS#1 v1.5 + SHA-256 signature, base64 output.
 * `pkcs8Pem` must be "-----BEGIN PRIVATE KEY-----". Convert a .pfx once with:
 *   openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
 * (add -legacy on OpenSSL 3+ if the .pfx uses RC2/3DES).
 */
export async function rsaSha256SignBase64(pkcs8Pem: string, message: string): Promise<string> {
  if (pkcs8Pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("PKCS#1 key given; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem");
  }
  const der = fromBase64(pkcs8Pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  const key = await subtle.importKey("pkcs8", der as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(message) as BufferSource)));
}

/** Constant-time string comparison (avoid leaking signature prefixes via timing). */
export function safeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// HTTP with timeouts. Retries only for idempotent reads (status checks).
// ---------------------------------------------------------------------------

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown; // objects are JSON-encoded; strings sent as-is
  timeoutMs?: number;
  retries?: number; // extra attempts on network error / 5xx / 429
}

export async function http<T = unknown>(
  provider: ProviderId,
  url: string,
  opts: HttpOptions = {},
): Promise<{ status: number; data: T; text: string }> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000, retries = 0 } = opts;
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  if (payload !== undefined && !Object.keys(finalHeaders).some((h) => h.toLowerCase() === "content-type")) {
    finalHeaders["Content-Type"] = "application/json";
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        lastErr = new PaymentError(`HTTP ${res.status}`, provider, "upstream_error", res.status, text);
        continue;
      }
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body: keep text */
      }
      return { status: res.status, data: data as T, text };
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
    }
  }
  throw new PaymentError(
    `request to ${new URL(url).host} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    provider,
    "network_error",
    undefined,
    lastErr,
  );
}

/** Basic auth header value. */
export const basicAuth = (user: string, pass: string): string => `Basic ${toBase64(utf8(`${user}:${pass}`))}`;

/** Escape for safe interpolation into HTML attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Server-rendered auto-submitting form for `kind: "form"` results. */
export function renderAutoSubmitForm(r: Extract<InitiateResult, { kind: "form" }>): string {
  const inputs = Object.entries(r.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to payment…</title></head><body><form id="f" method="POST" action="${escapeHtml(r.action)}"${r.enctype ? ` enctype="${r.enctype}"` : ""}>${inputs}<noscript><button type="submit">Continue to payment</button></noscript></form><script>document.getElementById("f").submit()</script></body></html>`;
}
