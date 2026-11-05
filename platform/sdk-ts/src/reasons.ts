// Short machine reasons (SPEC section 3, data.reason) from whatever a gateway module threw.
// Blog modules throw PaymentError with a message; skill adapters add a `code`.

const ADAPTER_CODES: Record<string, string> = {
  invalid_signature: "bad_signature",
  callback_mismatch: "id_mismatch",
  pidx_mismatch: "id_mismatch",
  malformed_callback: "malformed_callback",
  malformed_response: "malformed_response",
  currency_mismatch: "currency_mismatch",
  network_error: "network_error",
  upstream_error: "gateway_error",
  unauthorized: "unauthorized",
};

// Checked in order. Messages come from website/src/data/blog-code/* and the skill adapters.
const MESSAGE_RULES: [RegExp, string][] = [
  [/amount mismatch|has no tranamount|no amount/i, "amount_mismatch"],
  [/currency mismatch/i, "currency_mismatch"],
  [/signature|\bDV\b|not signed/i, "bad_signature"],
  [/different payment|id mismatch|does not match/i, "id_mismatch"],
  [/not base64|malformed|not json/i, "malformed_callback"],
  [/timed? ?out|timeout/i, "timeout"],
  [/status check failed|HTTP [45]\d\d|unavailable/i, "gateway_error"],
  [/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i, "network_error"],
];

/** Maps a thrown value to a reason code: amount_mismatch, bad_signature, id_mismatch, timeout, ... */
export function reasonOf(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    if (typeof e.code === "string" && Object.hasOwn(ADAPTER_CODES, e.code)) {
      // network_error from the adapters' http() wraps the real cause; a timeout is more useful.
      if (e.code === "network_error" && typeof e.message === "string" && /timed? ?out|timeout|abort/i.test(e.message)) return "timeout";
      return ADAPTER_CODES[e.code];
    }
    const msg = typeof e.message === "string" ? e.message : "";
    for (const [re, reason] of MESSAGE_RULES) if (re.test(msg)) return reason;
    if (typeof e.code === "string" && /^[a-z_]{2,40}$/.test(e.code)) return e.code;
    if (e.cause) {
      const inner = reasonOf(e.cause);
      if (inner !== "exception") return inner;
    }
  }
  return "exception";
}

/** Callback-side failures: the module throws these before it calls the gateway. */
export const CALLBACK_REASONS = new Set(["bad_signature", "malformed_callback"]);

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
