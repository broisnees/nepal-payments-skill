/** Typed shapes of Khalti responses, and the guards that produce them from untyped JSON. */
import { responseError, type FailedResponse, type PaymentError } from "../../core/errors.ts";
import { isRecord } from "../../core/records.ts";

export interface InitiateResponse {
  pidx: string;
  payment_url: string;
  expires_at: string;
  expires_in: number;
  [k: string]: unknown;
}

export function isInitiateResponse(value: unknown): value is InitiateResponse {
  return isRecord(value) && Boolean(value.pidx);
}

/** Lookup answer. `status` is the only field relied on; the rest is read defensively. */
export interface LookupResponse {
  pidx?: unknown;
  total_amount?: unknown;
  status: string;
  transaction_id?: unknown;
  fee?: unknown;
  refunded?: unknown;
  [k: string]: unknown;
}

export function isLookupResponse(value: unknown): value is LookupResponse {
  return isRecord(value) && typeof value.status === "string";
}

/** 404, or Khalti's `{"detail": "Not found."}` body. */
export function isNotFound(res: FailedResponse): boolean {
  return res.status === 404 || (isRecord(res.data) && res.data.detail === "Not found.");
}

/** Khalti's `error_key`, `unauthorized` for 401, else `http_<status>`. */
function errorKey(data: unknown, status: number): string {
  if (status === 401) return "unauthorized";
  const key = isRecord(data) ? data.error_key : undefined;
  return key ? String(key) : `http_${status}`;
}

/** Field errors are `{field: ["msg", ...]}`; `detail` is a single message. */
function errorMessageParts(data: unknown): { summary: string; detail: string } {
  if (typeof data !== "object" || data === null) {
    return { summary: "Khalti error", detail: String(data).slice(0, 200) };
  }
  const body: Record<string, unknown> = { ...data }; // arrays too: their entries are "0", "1", ...
  if (body.detail) return { summary: "Khalti", detail: String(body.detail) };
  const fields = Object.entries(body)
    .filter(([key]) => key !== "error_key" && key !== "status_code")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" ") : String(value)}`);
  return { summary: "Khalti", detail: fields.join("; ") || "unknown error" };
}

export function khaltiError(res: FailedResponse): PaymentError {
  const { summary, detail } = errorMessageParts(res.data);
  return responseError("khalti", res, summary, { detail, code: errorKey(res.data, res.status) });
}
