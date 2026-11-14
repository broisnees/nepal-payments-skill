/** Typed shapes of IME Pay responses, and the guards that produce them from untyped JSON. */
import { bodyExcerpt, responseError, type FailedResponse } from "../../core/errors.ts";
import type { PaymentError } from "../../core/errors.ts";
import { isRecord } from "../../core/records.ts";

export interface GetTokenResponse {
  TokenId?: unknown;
  ResponseCode?: unknown;
  ResponseDescription?: unknown;
  [k: string]: unknown;
}

/** GetToken succeeded: a TokenId and ResponseCode 0. */
export function tokenFrom(res: FailedResponse): string | undefined {
  const body: GetTokenResponse = isRecord(res.data) ? res.data : {};
  if (res.status !== 200 || !body.TokenId || String(body.ResponseCode) !== "0") return undefined;
  return String(body.TokenId);
}

export function getTokenError(res: FailedResponse): PaymentError {
  const body: GetTokenResponse = isRecord(res.data) ? res.data : {};
  const description = body.ResponseDescription;
  const detail =
    description === undefined || description === null ? bodyExcerpt(res.text) : String(description);
  const code = `imepay_${body.ResponseCode ?? res.status}`;
  return responseError("imepay", res, "IME Pay GetToken failed", { detail, code });
}

export interface RecheckResponse {
  ResponseCode: unknown;
  RefId?: unknown;
  TranAmount?: unknown;
  TransactionId?: unknown;
  Msisdn?: unknown;
  [k: string]: unknown;
}

export function isRecheckResponse(value: unknown): value is RecheckResponse {
  return isRecord(value) && value.ResponseCode !== undefined;
}
