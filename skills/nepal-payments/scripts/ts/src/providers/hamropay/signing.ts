/**
 * Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
 *   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey
 *                    (header "Signature")
 *   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey
 *                    (form field "token")
 *   get txn        = merchantTxnId,merchantId,clientId,clientApiKey      (header "Signature")
 *   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret
 *                    (header "Signature")
 */
import { hmac } from "../../core/crypto.ts";
import { toBase64 } from "../../core/encoding.ts";

/**
 * base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a
 * value would let two different tuples share a signature: refuse it instead.
 */
export async function hamroPaySign(secret: string, values: (string | number)[]): Promise<string> {
  if (values.some((v) => String(v).includes(","))) {
    throw new Error("hamropay: signed values must not contain commas");
  }
  return toBase64(await hmac("SHA-512", secret, values.join(",")));
}

/**
 * Hamro Pay signs its own rendering of the webhook amount (a double), which may be "1200",
 * "1200.0" or "1200.00": every distinct form of the PARSED number.
 */
export function webhookAmountRenderings(amount: number): string[] {
  return [...new Set([String(amount), amount.toFixed(2), `${amount}.0`, amount.toFixed(1)])];
}
