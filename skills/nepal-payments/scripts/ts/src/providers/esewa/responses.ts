/** Typed shapes of eSewa responses, and the guards that produce them from untyped JSON. */
import { bodyExcerpt, responseError, type FailedResponse } from "../../core/errors.ts";
import { isRecord } from "../../core/records.ts";
import type { PaymentError } from "../../core/errors.ts";

/** The base64 JSON eSewa appends to success_url as `?data=`. */
export interface EsewaSuccessPayload {
  transaction_code: string;
  status: string;
  total_amount: string | number;
  transaction_uuid: string;
  product_code: string;
  signed_field_names: string;
  signature: string;
  [k: string]: unknown;
}

/** Minimal check before the signature is verified: an object naming its signed fields. */
export function isSuccessPayload(value: unknown): value is EsewaSuccessPayload {
  return isRecord(value) && typeof value.signed_field_names === "string";
}

/** ePay status API answer. Only `status` is guaranteed; the rest is read defensively. */
export interface EsewaStatusResponse {
  status: unknown;
  product_code?: unknown;
  transaction_uuid?: unknown;
  total_amount?: unknown;
  ref_id?: unknown;
  [k: string]: unknown;
}

export function isStatusResponse(value: unknown): value is EsewaStatusResponse {
  return isRecord(value) && "status" in value;
}

/** Intent /book answer, `data` part. */
export interface IntentBooking {
  booking_id: string;
  deeplink: string;
  correlation_id: string;
}

/** `data` of an Intent /book answer when it carries a booking_id, else undefined. */
export function intentBookingFrom(body: unknown): IntentBooking | undefined {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || !data.booking_id) return undefined;
  return {
    booking_id: String(data.booking_id),
    deeplink: String(data.deeplink),
    correlation_id: String(data.correlation_id),
  };
}

/** Intent /status answer, `data` part. Fields are read defensively. */
export type IntentStatus = Record<string, unknown>;

/** `data` of an Intent /status answer when it carries a status, else undefined. */
export function intentStatusFrom(body: unknown): IntentStatus | undefined {
  const data = isRecord(body) ? body.data : undefined;
  return isRecord(data) && data.status ? data : undefined;
}

/**
 * Error from an eSewa error body: docs say `error_message`, the live Intent sandbox sends
 * `errorMessage`. Code is `esewa_<code>` when the body carries a code, else `http_<status>`.
 */
export function esewaError(res: FailedResponse, summary: string): PaymentError {
  const body = isRecord(res.data) ? res.data : {};
  const message = body.error_message ?? body.errorMessage;
  const detail =
    message === undefined || message === null ? bodyExcerpt(res.text) : String(message);
  const hasCode = body.code !== undefined && body.code !== null;
  const code = hasCode ? `esewa_${body.code}` : `http_${res.status}`;
  return responseError("esewa", res, summary, { detail, code });
}
