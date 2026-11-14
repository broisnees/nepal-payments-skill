/** Typed shapes of Hamro Pay responses, and the guards that produce them from untyped JSON. */
import { bodyExcerpt, PaymentError, responseError } from "../../core/errors.ts";
import type { FailedResponse } from "../../core/errors.ts";
import { isObjectLike } from "../../core/records.ts";
import { UNAUTHORIZED_CODE } from "./endpoints.ts";

/** Every Hamro Pay answer is a JSON object; errors add `code` + `message`. */
export type HamroPayBody = Record<string, unknown>;

export interface CreateSessionResponse {
  sessionId?: unknown;
  merchantId?: unknown;
  [k: string]: unknown;
}

/**
 * The object body of a 200 answer, or a PaymentError: `unauthorized` for 401 / code 16,
 * `code_<code>` when the body carries one, else `http_<status>`.
 */
export function bodyOrError(res: FailedResponse, path: string): HamroPayBody | PaymentError {
  const body = isObjectLike(res.data) ? res.data : undefined;
  if (res.status === 401 || body?.code === UNAUTHORIZED_CODE) {
    return new PaymentError(
      "Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)",
      "hamropay",
      "unauthorized",
      res.status,
      res.data,
    );
  }
  if (res.status === 200 && body) return body;
  const detail = typeof body?.message === "string" ? body.message : bodyExcerpt(res.text);
  const code = body?.code != null ? `code_${body.code}` : `http_${res.status}`;
  return responseError("hamropay", res, `Hamro Pay ${path} failed`, { detail, code });
}

/**
 * merchantTxnId echoed by Get Transaction. The reference names it merchantTransactionId; the
 * live API answers merchantTxnId.
 */
export function echoedTxnId(body: HamroPayBody): unknown {
  return body.merchantTransactionId ?? body.merchantTxnId;
}
