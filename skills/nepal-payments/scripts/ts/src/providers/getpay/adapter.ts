/**
 * GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure) —
 * https://getpay.global/web-integration/
 * Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid, tid}), oprKey,
 * insKey (blank when operator-hosted), the bundle URL and the base URL.
 *
 * Flow (browser SDK, four pages): checkout page loads bundle.js and runs
 *   new GetPay(options).initialize()
 *   -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
 *   -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the
 *      query or the #hash
 *   -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status
 *      {id, papInfo}.
 *
 * merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT),
 * so a paid status only counts when the token's oprSecret matches YOUR oprKey and data.clientId
 * is YOUR orderId.
 */
import { safeEqual } from "../../core/crypto.ts";
import { PaymentError } from "../../core/errors.ts";
import { escapeHtml } from "../../core/html.ts";
import { http } from "../../core/http.ts";
import { assertPaisa, rupeesToPaisa } from "../../core/money.ts";
import { asString, isRupeeAmount, lookup } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  PaymentStatus,
  SdkResult,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { GetPayConfig } from "./config.ts";
import { BASE, BUNDLE, TXN_STATUS, type GetPayApiPath } from "./endpoints.ts";
import { checkoutPage, paymentPage, returnPage } from "./pages.ts";
import {
  getPayError,
  isNotFoundAnswer,
  transactionFrom,
  type GetPayTransaction,
} from "./responses.ts";
import { getPayDecodeToken, getPayOprSecret } from "./signing.ts";

export interface GetPayInitiateExtras {
  orderInformationUI?: string;
  allowBillingAddressFields?: boolean;
}

const statusOf = (value: unknown): PaymentStatus =>
  lookup(TXN_STATUS, String(value ?? "").toUpperCase()) ?? "unknown";

const amountOf = (value: unknown): number | null =>
  value !== undefined && value !== null && isRupeeAmount(value) ? rupeesToPaisa(value) : null;

function assertClientRequestId(orderId: string): void {
  if (!/^[A-Za-z0-9-]{1,50}$/.test(orderId)) {
    throw new PaymentError(
      "GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]",
      "getpay",
      "invalid_order_id",
    );
  }
}

/** Default order summary shown inside GetPay's checkout. */
function orderSummaryHtml(description: string, currency: string, amountPaisa: number): string {
  return (
    `<div style="font-family:sans-serif"><h3>${escapeHtml(description)}</h3>` +
    `<p>${escapeHtml(currency)} ${(amountPaisa / 100).toFixed(2)}</p></div>`
  );
}

export function getpay(cfg: GetPayConfig) {
  const base = (cfg.baseUrl ?? BASE[cfg.env]).replace(/\/$/, "");
  const bundleUrl = cfg.bundleUrl ?? BUNDLE;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const origin = new URL(cfg.websiteDomain).origin;
  const currency = cfg.currency ?? "NPR";

  /** POST a status API. null when GetPay says "not found"; throws on any other failure. */
  async function call(
    path: GetPayApiPath,
    body: Record<string, string>,
  ): Promise<GetPayTransaction | null> {
    const res = await http("getpay", `${base}/${path}`, {
      method: "POST",
      body,
      timeoutMs,
      retries: 2,
    });
    if (isNotFoundAnswer(res.data)) return null;
    const transaction = transactionFrom(res);
    if (!transaction) throw getPayError(res, path);
    return transaction;
  }

  /** GetPay requires both callback URLs on websiteDomain. */
  function assertSameOrigin(urls: string[]): void {
    for (const url of urls) {
      if (new URL(url).origin !== origin) {
        throw new PaymentError(
          `GetPay callback ${url} must be on websiteDomain ${origin}`,
          "getpay",
          "invalid_callback_url",
        );
      }
    }
  }

  const notFound = (orderId: string, transactionId: string | null): VerifyResult => ({
    provider: "getpay",
    status: "not_found",
    orderId,
    amountPaisa: null,
    transactionId,
    raw: null,
  });

  /**
   * Reconciliation without a token: transaction-statement by clientRequestId. It cannot prove
   * the transaction is yours, so a success there comes back "unknown" for manual review.
   */
  async function verifyByStatement(orderId: string): Promise<VerifyResult> {
    const s = await call("transaction-statement", { clientRequestId: orderId });
    if (!s) return notFound(orderId, null);
    const status = statusOf(s.status);
    return {
      provider: "getpay",
      status: status === "paid" ? "unknown" : status,
      orderId,
      amountPaisa: amountOf(s.saleTransactionAmount),
      transactionId: asString(s.transactionId) ?? null,
      raw: s,
    };
  }

  /** Return token: oprSecret checked against oprKey, then merchant-status, then the orderId. */
  async function verifyByToken(orderId: string, token: string): Promise<VerifyResult> {
    const t = getPayDecodeToken(token);
    if (!t) {
      throw new PaymentError(
        "GetPay: return token is not base64 {id, oprSecret}",
        "getpay",
        "malformed_callback",
        400,
      );
    }
    if (!safeEqual(await getPayOprSecret(cfg.oprKey, t.id), t.oprSecret)) {
      throw new PaymentError(
        "GetPay: oprSecret does not match oprKey + id",
        "getpay",
        "bad_signature",
        400,
        { id: t.id },
      );
    }
    const d = await adapter.status(t.id);
    if (!d) return notFound(orderId, t.id);
    if (String(d.clientId ?? "") !== orderId) {
      throw new PaymentError(
        "GetPay: transaction belongs to a different clientRequestId",
        "getpay",
        "id_mismatch",
        400,
        d,
      );
    }
    return {
      provider: "getpay",
      status: statusOf(d.status),
      orderId,
      amountPaisa: amountOf(d.amount),
      transactionId: t.id,
      raw: d,
    };
  }

  const adapter = {
    id: "getpay" as const,

    /**
     * Options for the browser SDK. clientRequestId = orderId. returnUrl / failureUrl must be on
     * websiteDomain and must serve returnPage() (the token can arrive in the #hash, which only
     * the browser sees).
     */
    async initiate(input: InitiateInput & GetPayInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "getpay");
      assertClientRequestId(input.orderId);
      const failUrl = input.failureUrl ?? input.returnUrl;
      assertSameOrigin([input.returnUrl, failUrl]);
      const customer = input.customer ?? {};
      return {
        kind: "sdk",
        scriptUrl: bundleUrl,
        options: {
          clientRequestId: input.orderId,
          papInfo: cfg.papInfo,
          oprKey: cfg.oprKey,
          insKey: cfg.insKey ?? "",
          websiteDomain: origin,
          baseUrl: base,
          price: input.amountPaisa / 100, // GetPay wants a number, not a string
          currency,
          businessName: cfg.businessName,
          imageUrl: cfg.imageUrl,
          themeColor: cfg.themeColor ?? "#5662FF",
          allowBillingAddressFields: input.allowBillingAddressFields ?? true,
          userInfo: {
            name: customer.name ?? "",
            email: customer.email ?? "",
            state: "",
            country: "",
            zipcode: "",
            city: "",
            address: "",
          },
          prefill: {
            name: !!customer.name,
            email: !!customer.email,
            state: false,
            city: false,
            address: false,
            zipcode: false,
            country: false,
          },
          disableFields: {},
          callbackUrl: { successUrl: input.returnUrl, failUrl },
          orderInformationUI:
            input.orderInformationUI ??
            orderSummaryHtml(input.description, currency, input.amountPaisa),
        },
      };
    },

    /**
     * With callback.token: check oprSecret against oprKey, then merchant-status, then the
     * transaction must carry your orderId. Without a token (reconciliation):
     * transaction-statement by clientRequestId, which cannot prove the transaction is yours, so
     * a success there comes back "unknown" for manual review.
     */
    async verify({ orderId, callback }: VerifyInput): Promise<VerifyResult> {
      const token = callback?.token;
      if (!token) return verifyByStatement(orderId);
      return verifyByToken(orderId, token);
    },

    /**
     * merchant-status by GetPay transaction id:
     * {status, amount, currency, stan, crrn, clientId, remarks}; null if unknown.
     */
    status(transactionId: string) {
      return call("merchant-status", { id: transactionId, papInfo: cfg.papInfo });
    },

    /**
     * transaction-statement: payer, masked PAN, scheme, stan, crrn. Query by transactionId or
     * clientRequestId.
     */
    statement(q: { transactionId: string } | { clientRequestId: string }) {
      const body: Record<string, string> = { ...q };
      return call("transaction-statement", body);
    },

    /**
     * The orderId is in YOUR return URL path (GetPay adds only the token); extract it from the
     * route instead.
     */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.clientRequestId || params.orderId || null;
    },

    /** Page 1: loads the bundle and starts checkout; onSuccess opens `paymentPageUrl`. */
    checkoutPage(r: SdkResult, paymentPageUrl: string): string {
      return checkoutPage(r, paymentPageUrl);
    },

    /** Page 2: GetPay renders the card form into #checkout. */
    paymentPage(): string {
      return paymentPage(bundleUrl);
    },

    /**
     * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from
     * the query or the #hash, and send it to `verifyUrl` as ?token=. Your server then calls
     * verify() with callback.token.
     */
    returnPage(verifyUrl: string): string {
      return returnPage(verifyUrl);
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
