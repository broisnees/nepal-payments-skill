/**
 * IME Pay has no HMAC: requests carry Basic auth + `Module: base64(moduleName)`, and callbacks
 * are UNSIGNED, so Recheck is the only proof of payment. The only "signing" is encoding the
 * WebCheckout payload.
 */
import { toBase64, utf8 } from "../../core/encoding.ts";

/** "100.00": IME Pay wants rupees with two decimals. */
export const amount2dp = (paisa: number) => (paisa / 100).toFixed(2);

export interface CheckoutPayload {
  token: string;
  merchantCode: string;
  refId: string;
  amount: string;
  returnUrl: string;
  cancelUrl: string;
}

/** base64("TokenId|MerchantCode|RefId|Amount|POST|RespUrl|CancelUrl") (official plugin format). */
export function checkoutData(p: CheckoutPayload): string {
  const fields = [p.token, p.merchantCode, p.refId, p.amount, "POST", p.returnUrl, p.cancelUrl];
  return toBase64(utf8(fields.join("|")));
}
