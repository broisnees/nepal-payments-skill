/**
 * IME Pay web checkout. Source: IME Pay's official WooCommerce + WHMCS plugins
 * (github.com/khalti/imepay-dev-docs).
 * Note: IME Pay merged into Khalti ("Khalti by IME", July 2025). For new builds prefer Khalti;
 * use this for existing IME Pay merchant accounts. Confirm with the Khalti-by-IME merchant team
 * that web checkout is open to you.
 *
 * Auth: Basic base64(username:password) + header `Module: base64(moduleName)`. No HMAC;
 * callbacks are UNSIGNED, so Recheck is the only proof of payment.
 */
import { toBase64, utf8 } from "../../core/encoding.ts";
import { PaymentError, responseError } from "../../core/errors.ts";
import { basicAuth, http } from "../../core/http.ts";
import { assertPaisa, rupeesToPaisa } from "../../core/money.ts";
import { isRupeeAmount } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { ImePayConfig } from "./config.ts";
import {
  BASE,
  CHECKOUT_PATH,
  GET_TOKEN_PATH,
  isPaidResponseCode,
  RECHECK_PATH,
} from "./endpoints.ts";
import { getTokenError, isRecheckResponse, tokenFrom } from "./responses.ts";
import { amount2dp, checkoutData } from "./signing.ts";

/** TranAmount as paisa; null when IME Pay sent none (the amount guard then flags review). */
function tranAmountPaisa(tranAmount: unknown): number | null {
  if (tranAmount === "" || !isRupeeAmount(tranAmount)) return null;
  return rupeesToPaisa(tranAmount);
}

export function imepay(cfg: ImePayConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const headers = {
    Authorization: basicAuth(cfg.username, cfg.password),
    Module: toBase64(utf8(cfg.module)),
  };

  const adapter = {
    id: "imepay" as const,

    /**
     * GetToken -> redirect to WebCheckout with base64 payload. IME POSTs the result
     * (ResponseCode, RefId, TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl.
     * `providerRef` = TokenId (persist it).
     */
    async initiate(input: InitiateInput): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "imepay");
      const Amount = amount2dp(input.amountPaisa);
      const res = await http("imepay", `${base}${GET_TOKEN_PATH}`, {
        method: "POST",
        headers,
        body: { MerchantCode: cfg.merchantCode, Amount, RefId: input.orderId },
        timeoutMs,
      });
      const token = tokenFrom(res);
      if (!token) throw getTokenError(res);
      const data = checkoutData({
        token,
        merchantCode: cfg.merchantCode,
        refId: input.orderId,
        amount: Amount,
        returnUrl: input.returnUrl,
        cancelUrl: input.failureUrl ?? input.returnUrl,
      });
      return {
        kind: "redirect",
        url: `${base}${CHECKOUT_PATH}?data=${encodeURIComponent(data)}`,
        providerRef: token,
        raw: res.data,
      };
    },

    /**
     * Recheck — authoritative. ResponseCode 0 = paid. Other codes are inconsistently documented:
     * treated as pending.
     */
    async verify({ orderId, providerRef }: VerifyInput): Promise<VerifyResult> {
      if (!providerRef) {
        throw new PaymentError(
          "IME Pay: stored TokenId required for verify",
          "imepay",
          "missing_token",
        );
      }
      const res = await http("imepay", `${base}${RECHECK_PATH}`, {
        method: "POST",
        headers,
        body: { MerchantCode: cfg.merchantCode, RefId: orderId, TokenId: providerRef },
        timeoutMs,
        retries: 2,
      });
      if (res.status !== 200 || !isRecheckResponse(res.data)) {
        throw responseError("imepay", res, "IME Pay Recheck failed");
      }
      const d = res.data;
      if (d.RefId && d.RefId !== orderId) {
        throw new PaymentError(
          "IME Pay: Recheck is for a different RefId",
          "imepay",
          "callback_mismatch",
          400,
          d,
        );
      }
      return {
        provider: "imepay",
        // Non-zero codes disagree across sources (1 = failed vs pending), so never mark failed
        // from them; the reconciliation job escalates the attempt for human review at its cutoff.
        status: isPaidResponseCode(d.ResponseCode) ? "paid" : "pending",
        orderId,
        amountPaisa: tranAmountPaisa(d.TranAmount),
        transactionId: d.TransactionId ? String(d.TransactionId) : null,
        raw: d,
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.RefId || null;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
