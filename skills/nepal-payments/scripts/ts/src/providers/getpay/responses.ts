/** Typed shapes of GetPay responses, and the guards that produce them from untyped JSON. */
import { responseError, type FailedResponse, type PaymentError } from "../../core/errors.ts";
import { isObjectLike, isRecord } from "../../core/records.ts";

/**
 * `data` of a merchant-status answer: {status, amount, currency, stan, crrn, clientId, remarks};
 * of a transaction-statement answer: payer, masked PAN, scheme, stan, crrn, saleTransactionAmount.
 * Fields are read defensively.
 */
export type GetPayTransaction = Record<string, unknown>;

/** GetPay's `{status: -1, message: "... not found ..."}` answer. */
export function isNotFoundAnswer(body: unknown): boolean {
  return isRecord(body) && body.status === -1 && /not found/i.test(String(body.message));
}

/** `data` of a successful answer (`status: 0` with an object `data`), else undefined. */
export function transactionFrom(res: FailedResponse): GetPayTransaction | undefined {
  if (res.status !== 200 || !isObjectLike(res.data) || res.data.status !== 0) return undefined;
  return isObjectLike(res.data.data) ? res.data.data : undefined;
}

export function getPayError(res: FailedResponse, path: string): PaymentError {
  const message = isRecord(res.data) ? res.data.message : undefined;
  const detail = message === undefined || message === null ? undefined : String(message);
  return responseError("getpay", res, `GetPay ${path} failed`, { detail });
}
