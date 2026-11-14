/**
 * Fonepay — Web payment (redirect) + Dynamic QR.
 * Source: "Technical Specification Document (Fonepay Web Integration) v2.0" + Dynamic QR spec
 * v1.1 (2024). Credentials come from your acquiring bank / Fonepay merchant onboarding.
 * Signature formats: see signing.ts.
 */
import { safeEqual } from "../../core/crypto.ts";
import { bodyExcerpt, PaymentError, responseError } from "../../core/errors.ts";
import { basicAuth, http } from "../../core/http.ts";
import { assertPaisa, paisaToRupees, rupeesToPaisa } from "../../core/money.ts";
import { asString, lookup, stringOrNull } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  PaymentStatus,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { FonepayConfig } from "./config.ts";
import { QR_WEBSOCKET_HOST, TXN_STATUS, URLS } from "./endpoints.ts";
import {
  isPaymentStatusResponse,
  isQrCreateResponse,
  messageOf,
  xmlTag,
  type PaymentStatusResponse,
} from "./responses.ts";
import {
  fonepayDate,
  fonepayHmac,
  requestDvValues,
  RESPONSE_DV_FIELDS,
  txnVerificationAuth,
  txnVerificationBody,
} from "./signing.ts";

export interface FonepayQrCreateInput {
  orderId: string;
  amountPaisa: number;
  remarks1: string;
  remarks2?: string;
}

const DV_FIELD_NAMES: readonly string[] = RESPONSE_DV_FIELDS;

/** Does this callback look like a Fonepay redirect (carries the DV or any DV-signed field)? */
const isFonepayCallback = (callback: Record<string, string>) =>
  Object.keys(callback).some((k) => k === "DV" || DV_FIELD_NAMES.includes(k));

function assertPrnAndReturnUrl(input: InitiateInput): void {
  if (input.orderId.length < 3 || input.orderId.length > 25) {
    throw new PaymentError("Fonepay PRN must be 3–25 chars", "fonepay", "invalid_order_id");
  }
  if (input.returnUrl.length > 150) {
    throw new PaymentError("Fonepay RU must be <= 150 chars", "fonepay", "invalid_return_url");
  }
}

/** Fonepay has been seen returning a localhost host here; rewrite to the real socket host. */
function fixWebSocketUrl(url: string | undefined, realHost: string): string | undefined {
  if (!url?.includes("localhost")) return url;
  return url.replace(/^wss?:\/\/[^/]+/, realHost);
}

export function fonepay(cfg: FonepayConfig) {
  const defaults = URLS[cfg.env];
  const urls = {
    payment: cfg.paymentUrl ?? defaults.payment,
    legacyVerify: cfg.legacyVerifyUrl ?? defaults.legacyVerify,
    txnVerification: cfg.txnVerificationUrl ?? defaults.txnVerification,
    qrBase: cfg.qrBaseUrl ?? defaults.qrBase,
  };
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const strict = cfg.strictSignature ?? true;
  const sign = (values: (string | number)[]) => fonepayHmac(cfg.secretKey, values);

  function requireLogin(purpose: string): { username: string; password: string } {
    if (!cfg.username || !cfg.password) {
      throw new Error(`fonepay: username/password required for ${purpose}`);
    }
    return { username: cfg.username, password: cfg.password };
  }

  async function callbackValid(params: Record<string, string>): Promise<boolean> {
    if (!params.DV) return false;
    const expected = await sign(RESPONSE_DV_FIELDS.map((f) => params[f] ?? ""));
    return safeEqual(expected, params.DV.toUpperCase());
  }

  /**
   * Callback params are trusted ONLY with a valid DV. A missing DV is treated exactly like a
   * bad one, otherwise anyone could send ?PRN=<id>&PS=false without a DV and force a "failed"
   * outcome. Returns the DV-verified params, or undefined when there are none to trust.
   */
  async function trustedCallback(
    callback: Record<string, string> | undefined,
    orderId: string,
  ): Promise<Record<string, string> | undefined> {
    if (!callback || !isFonepayCallback(callback)) return undefined;
    if (await callbackValid(callback)) {
      if (callback.PRN !== orderId || callback.PID !== cfg.merchantCode) {
        throw new PaymentError(
          "Fonepay: callback does not match this attempt",
          "fonepay",
          "callback_mismatch",
          400,
          callback,
        );
      }
      return callback;
    }
    if (strict) {
      throw new PaymentError(
        "Fonepay: missing or invalid response DV",
        "fonepay",
        "invalid_signature",
        400,
        callback,
      );
    }
    return undefined;
  }

  async function txnVerification(prn: string, amountPaisa: number): Promise<PaymentStatusResponse> {
    const { username, password } = requireLogin("txnVerification");
    const body = txnVerificationBody(prn, cfg.merchantCode, paisaToRupees(amountPaisa));
    const auth = await txnVerificationAuth(cfg.secretKey, username, password, body);
    const res = await http("fonepay", urls.txnVerification, {
      method: "POST",
      headers: {
        Authorization: basicAuth(username, password),
        auth,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs,
      retries: 2,
    });
    if (res.status !== 200 || !isPaymentStatusResponse(res.data)) {
      throw responseError("fonepay", res, "Fonepay txnVerification failed");
    }
    return res.data;
  }

  /** Legacy (2019) GET verification; needs UID + BC from the redirect. Returns XML. */
  async function legacyVerify(prn: string, amountPaisa: number, uid: string, bankCode: string) {
    const AMT = paisaToRupees(amountPaisa);
    const DV = await sign([cfg.merchantCode, AMT, prn, bankCode, uid]);
    const query = new URLSearchParams({
      PRN: prn,
      PID: cfg.merchantCode,
      BID: bankCode,
      AMT,
      UID: uid,
      DV,
    });
    const res = await http("fonepay", `${urls.legacyVerify}?${query}`, {
      timeoutMs,
      retries: 2,
      headers: { Accept: "application/xml" },
    });
    // A 5xx / WAF page / HTML must never read as "not paid": throw so the attempt stays open.
    if (res.status !== 200) {
      throw new PaymentError(
        `Fonepay verification HTTP ${res.status}`,
        "fonepay",
        "upstream_error",
        res.status,
        bodyExcerpt(res.text, 500),
      );
    }
    const responseCode = xmlTag(res.text, "response_code");
    if (responseCode === undefined) {
      throw new PaymentError(
        "Fonepay verification: unparseable response",
        "fonepay",
        "malformed_response",
        res.status,
        bodyExcerpt(res.text, 500),
      );
    }
    const ok = responseCode === "successful" && xmlTag(res.text, "success") === "true";
    return { ok, text: res.text, status: res.status };
  }

  /** verify() via txnVerification (username/password configured). */
  async function verifyWithTxnVerification(
    orderId: string,
    amountPaisa: number,
    trusted: Record<string, string> | undefined,
  ): Promise<VerifyResult> {
    const r = await txnVerification(orderId, amountPaisa);
    const traceId = stringOrNull(r.fonepayTraceId);
    return {
      provider: "fonepay",
      status: lookup(TXN_STATUS, r.paymentStatus.toLowerCase()) ?? "unknown",
      orderId,
      amountPaisa: r.requestedAmount ? rupeesToPaisa(String(r.requestedAmount)) : null,
      transactionId: traceId ?? trusted?.UID ?? null,
      raw: r,
    };
  }

  /** verify() via the legacy GET, using the DV-verified redirect params. */
  async function verifyWithLegacy(
    orderId: string,
    amountPaisa: number,
    trusted: Record<string, string>,
  ): Promise<VerifyResult> {
    // Authentic (DV-verified) negative outcome from Fonepay.
    if (trusted.PS !== "true" || trusted.RC !== "successful") {
      const status: PaymentStatus = trusted.RC === "cancel" ? "canceled" : "failed";
      return {
        provider: "fonepay",
        status,
        orderId,
        amountPaisa: null,
        transactionId: trusted.UID || null,
        raw: trusted,
      };
    }
    const r = await legacyVerify(orderId, amountPaisa, trusted.UID, trusted.BC);
    return {
      provider: "fonepay",
      status: r.ok ? "paid" : "failed",
      orderId,
      // R_AMT = amount requested by merchant (DV-signed)
      amountPaisa: trusted.R_AMT ? rupeesToPaisa(trusted.R_AMT) : null,
      transactionId: trusted.UID,
      raw: { callback: trusted, verification: r.text },
    };
  }

  const adapter = {
    id: "fonepay" as const,

    /**
     * Redirect URL for the Fonepay web payment page.
     * PRN = orderId (3–25 chars). Keep `returnUrl` (RU) <= 150 chars and free of query strings.
     */
    async initiate(input: InitiateInput & { remarks2?: string }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "fonepay");
      assertPrnAndReturnUrl(input);
      const params: Record<string, string> = {
        PID: cfg.merchantCode,
        MD: "P",
        PRN: input.orderId,
        AMT: paisaToRupees(input.amountPaisa), // rupees; the SAME string goes into DV
        CRN: "NPR",
        DT: fonepayDate(),
        R1: input.description.slice(0, 160) || "Payment",
        R2: (input.remarks2 ?? "N/A").slice(0, 50) || "N/A",
        RU: input.returnUrl,
      };
      params.DV = await sign(requestDvValues(params)); // raw (not URL-encoded) values
      return { kind: "redirect", url: `${urls.payment}?${new URLSearchParams(params)}` };
    },

    /**
     * Authoritative check. Uses txnVerification when username/password are configured (works
     * without a callback, so the reconciliation job can use it). Otherwise falls back to the
     * legacy GET verification, which needs UID + BC from the redirect params.
     */
    async verify({ orderId, amountPaisa, callback }: VerifyInput): Promise<VerifyResult> {
      const trusted = await trustedCallback(callback, orderId);
      if (cfg.username && cfg.password) {
        return verifyWithTxnVerification(orderId, amountPaisa, trusted);
      }
      if (trusted?.UID && trusted?.BC) return verifyWithLegacy(orderId, amountPaisa, trusted);
      throw new PaymentError(
        "Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password " +
          "are configured for txnVerification",
        "fonepay",
        "verify_unavailable",
      );
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.PRN || null;
    },

    callbackValid,

    // ------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

    /**
     * Create a dynamic QR. Render `qrMessage` as a QR code; listen on `webSocketUrl` or poll
     * qrStatus().
     */
    async qrCreate(input: FonepayQrCreateInput) {
      const { username, password } = requireLogin("Dynamic QR");
      assertPaisa(input.amountPaisa, "fonepay");
      const amount = paisaToRupees(input.amountPaisa);
      const remarks2 = input.remarks2 ?? "N/A";
      const signedValues = [amount, input.orderId, cfg.merchantCode, input.remarks1, remarks2];
      const body = {
        amount,
        remarks1: input.remarks1,
        remarks2,
        prn: input.orderId,
        merchantCode: cfg.merchantCode,
        dataValidation: (await sign(signedValues)).toLowerCase(),
        username,
        password,
      };
      const res = await http("fonepay", `${urls.qrBase}/thirdPartyDynamicQrDownload`, {
        method: "POST",
        body,
        timeoutMs,
      });
      if (!isQrCreateResponse(res.data)) {
        const message = messageOf(res.data);
        const detail = message === undefined || message === null ? undefined : String(message);
        throw responseError("fonepay", res, "Fonepay QR create failed", { detail });
      }
      const reportedUrl = asString(res.data.thirdpartyQrWebSocketUrl);
      return {
        qrMessage: String(res.data.qrMessage),
        webSocketUrl: fixWebSocketUrl(reportedUrl, QR_WEBSOCKET_HOST[cfg.env]),
        raw: res.data,
      };
    },

    /**
     * Poll QR payment status. Always call this after a websocket "paymentSuccess" message before
     * fulfilling. Pass the stored amount: the status response has none, but the QR was created
     * server-side with it.
     */
    async qrStatus(orderId: string, amountPaisa?: number): Promise<VerifyResult> {
      const { username, password } = requireLogin("Dynamic QR");
      const body = {
        prn: orderId,
        merchantCode: cfg.merchantCode,
        dataValidation: (await sign([orderId, cfg.merchantCode])).toLowerCase(),
        username,
        password,
      };
      const res = await http("fonepay", `${urls.qrBase}/thirdPartyDynamicQrGetStatus`, {
        method: "POST",
        body,
        timeoutMs,
        retries: 2,
      });
      if (!isPaymentStatusResponse(res.data)) {
        throw responseError("fonepay", res, "Fonepay QR status failed");
      }
      return {
        provider: "fonepay",
        status: lookup(TXN_STATUS, res.data.paymentStatus.toLowerCase()) ?? "unknown",
        orderId,
        amountPaisa: amountPaisa ?? null,
        transactionId: stringOrNull(res.data.fonepayTraceId),
        raw: res.data,
      };
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
