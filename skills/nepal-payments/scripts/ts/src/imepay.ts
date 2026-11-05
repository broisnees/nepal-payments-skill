/**
 * IME Pay web checkout. Source: IME Pay's official WooCommerce + WHMCS plugins (github.com/khalti/imepay-dev-docs).
 * Note: IME Pay merged into Khalti ("Khalti by IME", July 2025). For new builds prefer Khalti; use this for
 * existing IME Pay merchant accounts. Confirm with the Khalti-by-IME merchant team that web checkout is open to you.
 *
 * Auth: Basic base64(username:password) + header `Module: base64(moduleName)`. No HMAC; callbacks are UNSIGNED,
 * so Recheck is the only proof of payment.
 * Port 7979 must be reachable outbound (IME may need to whitelist your server IP).
 */
import {
  basicAuth,
  http,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  toBase64,
  utf8,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface ImePayConfig {
  env: "sandbox" | "production";
  merchantCode: string;
  username: string;
  password: string;
  module: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BASE = { sandbox: "https://stg.imepay.com.np:7979", production: "https://payment.imepay.com.np:7979" } as const;

export function imepay(cfg: ImePayConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const headers = { Authorization: basicAuth(cfg.username, cfg.password), Module: toBase64(utf8(cfg.module)) };
  const amount2dp = (paisa: number) => (paisa / 100).toFixed(2); // "100.00"

  const adapter = {
    id: "imepay" as const,

    /**
     * GetToken -> redirect to WebCheckout with base64 payload. IME POSTs the result (ResponseCode, RefId,
     * TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl. `providerRef` = TokenId (persist it).
     */
    async initiate(input: InitiateInput): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "imepay");
      const Amount = amount2dp(input.amountPaisa);
      const res = await http<{ TokenId?: string; ResponseCode?: number | string; ResponseDescription?: string }>(
        "imepay",
        `${base}/api/Web/GetToken`,
        { method: "POST", headers, body: { MerchantCode: cfg.merchantCode, Amount, RefId: input.orderId }, timeoutMs },
      );
      if (res.status !== 200 || !res.data?.TokenId || String(res.data.ResponseCode) !== "0") {
        throw new PaymentError(
          `IME Pay GetToken failed: ${res.data?.ResponseDescription ?? res.text.slice(0, 200)}`,
          "imepay",
          `imepay_${res.data?.ResponseCode ?? res.status}`,
          res.status,
          res.data,
        );
      }
      const token = res.data.TokenId;
      const payload = [token, cfg.merchantCode, input.orderId, Amount, "POST", input.returnUrl, input.failureUrl ?? input.returnUrl].join("|");
      return {
        kind: "redirect",
        url: `${base}/WebCheckout/Checkout?data=${encodeURIComponent(toBase64(utf8(payload)))}`,
        providerRef: token,
        raw: res.data,
      };
    },

    /** Recheck — authoritative. ResponseCode 0 = paid. Other codes are inconsistently documented: treated as pending. */
    async verify({ orderId, providerRef }: VerifyInput): Promise<VerifyResult> {
      if (!providerRef) throw new PaymentError("IME Pay: stored TokenId required for verify", "imepay", "missing_token");
      const res = await http<Record<string, any>>("imepay", `${base}/api/Web/Recheck`, {
        method: "POST",
        headers,
        body: { MerchantCode: cfg.merchantCode, RefId: orderId, TokenId: providerRef },
        timeoutMs,
        retries: 2,
      });
      if (res.status !== 200 || res.data?.ResponseCode === undefined) {
        throw new PaymentError(`IME Pay Recheck failed: ${res.text.slice(0, 200)}`, "imepay", `http_${res.status}`, res.status, res.data);
      }
      const d = res.data;
      if (d.RefId && d.RefId !== orderId) {
        throw new PaymentError("IME Pay: Recheck is for a different RefId", "imepay", "callback_mismatch", 400, d);
      }
      const paid = String(d.ResponseCode) === "0";
      return {
        provider: "imepay",
        // Non-zero codes disagree across sources (1 = failed vs pending), so never mark failed from them;
        // the reconciliation job escalates the attempt for human review at its cutoff.
        status: paid ? "paid" : "pending",
        orderId,
        amountPaisa: d.TranAmount !== undefined && d.TranAmount !== null && d.TranAmount !== "" ? rupeesToPaisa(d.TranAmount) : null,
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

