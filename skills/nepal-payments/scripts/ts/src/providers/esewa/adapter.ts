/**
 * eSewa — https://developer.esewa.com.np
 *
 * Two flows:
 *  1. ePay v2 (web, also works in a mobile WebView): signed form POST -> eSewa
 *     -> success_url?data=<base64 JSON> -> verify response signature -> status API (authoritative).
 *  2. Intent (mobile app-to-app, eSewa's recommended replacement for its deprecated mobile SDKs):
 *     server books -> app opens deeplink -> eSewa POSTs callback_url + redirects redirect_url
 *     -> status API.
 */
import { safeEqual } from "../../core/crypto.ts";
import { base64Json, fromBase64 } from "../../core/encoding.ts";
import { PaymentError } from "../../core/errors.ts";
import { http } from "../../core/http.ts";
import { assertPaisa, paisaToRupees, rupeesToPaisa } from "../../core/money.ts";
import { isRecord, isRupeeAmount, lookup, stringOrNull } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { EsewaConfig } from "./config.ts";
import { EPAY_STATUS, INTENT_STATUS, URLS } from "./endpoints.ts";
import {
  esewaError,
  intentBookingFrom,
  intentStatusFrom,
  isStatusResponse,
  isSuccessPayload,
  type EsewaStatusResponse,
  type EsewaSuccessPayload,
} from "./responses.ts";
import {
  esewaSign,
  parseFieldNames,
  rawFields,
  signedIntentBody,
  stringFields,
} from "./signing.ts";

export type { EsewaSuccessPayload } from "./responses.ts";

export interface EsewaInitiateExtras {
  /**
   * Optional breakdown, INCLUDED in amountPaisa. amountPaisa is always the TOTAL charged — the
   * number you store and later pass to verify().
   * eSewa's `amount` field = amountPaisa - tax - service - delivery.
   */
  taxPaisa?: number;
  serviceChargePaisa?: number;
  deliveryChargePaisa?: number;
}

export interface EsewaIntentBookInput {
  orderId: string;
  amountPaisa: number;
  callbackUrl: string; // server-to-server POST from eSewa
  redirectUrl: string; // where the user lands after paying
  properties?: Record<string, string>; // snake_case keys; shown to the user
}

const EPAY_SIGNED_FIELDS = ["total_amount", "transaction_uuid", "product_code"];

/** Breakdown of an ePay total into eSewa's four amount fields, all in paisa. */
function splitTotal(input: InitiateInput & EsewaInitiateExtras) {
  const tax = input.taxPaisa ?? 0;
  const serviceCharge = input.serviceChargePaisa ?? 0;
  const deliveryCharge = input.deliveryChargePaisa ?? 0;
  const base = input.amountPaisa - tax - serviceCharge - deliveryCharge; // amountPaisa is the TOTAL
  const charges = [tax, serviceCharge, deliveryCharge];
  if (!charges.every((n) => Number.isSafeInteger(n) && n >= 0) || base <= 0) {
    throw new PaymentError(
      "eSewa: tax/charges must be non-negative paisa and less than the total",
      "esewa",
      "invalid_amount",
    );
  }
  return { base, tax, serviceCharge, deliveryCharge };
}

function assertTransactionUuid(orderId: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(orderId)) {
    throw new PaymentError(
      "eSewa transaction_uuid allows only letters, digits and '-'",
      "esewa",
      "invalid_order_id",
    );
  }
}

/** Decode the base64 `data` param into its JSON text and payload, or throw malformed_callback. */
function decodeSuccessData(data: string): { text: string; payload: EsewaSuccessPayload } {
  let text: string;
  let payload: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(data));
    payload = JSON.parse(text);
  } catch {
    throw new PaymentError(
      "eSewa: success data is not base64 JSON",
      "esewa",
      "malformed_callback",
      400,
      data,
    );
  }
  if (!isSuccessPayload(payload)) {
    throw new PaymentError(
      "eSewa: malformed success payload",
      "esewa",
      "malformed_callback",
      400,
      payload,
    );
  }
  return { text, payload };
}

export function esewa(cfg: EsewaConfig) {
  const urls = URLS[cfg.env];
  const formUrl = cfg.formUrl ?? urls.form;
  const statusUrl = cfg.statusUrl ?? urls.status;
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const strict = cfg.strictSignature ?? true;
  const secret = cfg.secretKey.replace(/&amp;/g, "&");

  /**
   * Decode + verify the base64 `data` param from success_url.
   * Does NOT prove payment; call verify().
   */
  async function parseSuccess(
    data: string,
  ): Promise<{ payload: EsewaSuccessPayload; signatureValid: boolean }> {
    const { text, payload } = decodeSuccessData(data);
    const order = parseFieldNames(payload.signed_field_names);
    const fields = rawFields(text, payload, order);
    const expected = await esewaSign(secret, fields, order);
    let signatureValid =
      typeof payload.signature === "string" && safeEqual(expected, payload.signature);
    // eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed.
    // Try both.
    if (!signatureValid && fields.total_amount?.includes(",")) {
      const withoutComma = { ...fields, total_amount: fields.total_amount.replace(/,/g, "") };
      signatureValid = safeEqual(await esewaSign(secret, withoutComma, order), payload.signature);
    }
    return { payload, signatureValid };
  }

  /** Check the success-redirect `data` belongs to this attempt and (when strict) is signed. */
  async function checkSuccessCallback(data: string, orderId: string): Promise<boolean> {
    const { payload, signatureValid } = await parseSuccess(data);
    if (payload.transaction_uuid !== orderId || payload.product_code !== cfg.productCode) {
      throw new PaymentError(
        "eSewa: callback does not match this attempt",
        "esewa",
        "callback_mismatch",
        400,
        payload,
      );
    }
    if (!signatureValid && strict) {
      throw new PaymentError(
        "eSewa: invalid response signature",
        "esewa",
        "invalid_signature",
        400,
        payload,
      );
    }
    return signatureValid;
  }

  async function statusCheck(orderId: string, amountPaisa: number): Promise<EsewaStatusResponse> {
    const query = new URLSearchParams({
      product_code: cfg.productCode,
      total_amount: paisaToRupees(amountPaisa),
      transaction_uuid: orderId,
    });
    const res = await http("esewa", `${statusUrl}?${query}`, { timeoutMs, retries: 2 });
    if (res.status !== 200 || !isStatusResponse(res.data)) {
      throw esewaError(res, "eSewa status check failed");
    }
    return res.data;
  }

  function requireIntent() {
    if (!cfg.intent)
      throw new Error("eSewa: configure `intent` credentials to use Intent payments");
    const baseUrl = cfg.intent.baseUrl ?? urls.intent;
    if (!baseUrl) {
      throw new Error(
        "eSewa: production Intent baseUrl is issued by eSewa at go-live; set intent.baseUrl",
      );
    }
    return { ...cfg.intent, baseUrl };
  }

  const adapter = {
    id: "esewa" as const,

    /**
     * Returns a form to auto-submit (application/x-www-form-urlencoded POST).
     * Keep `returnUrl`/`failureUrl` free of query strings — eSewa appends `?data=...`.
     * Put your attempt id in the PATH (e.g. /payments/esewa/return/<orderId>) so failures can be
     * matched too.
     */
    async initiate(input: InitiateInput & EsewaInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "esewa");
      assertTransactionUuid(input.orderId);
      const { base, tax, serviceCharge, deliveryCharge } = splitTotal(input);
      // Format ONCE and use the same strings in the form and in the signature
      // ("110" vs "110.0" -> ES104).
      const fields: Record<string, string> = {
        amount: paisaToRupees(base),
        tax_amount: paisaToRupees(tax),
        product_service_charge: paisaToRupees(serviceCharge),
        product_delivery_charge: paisaToRupees(deliveryCharge),
        total_amount: paisaToRupees(input.amountPaisa),
        transaction_uuid: input.orderId,
        product_code: cfg.productCode,
        success_url: input.returnUrl,
        failure_url: input.failureUrl ?? input.returnUrl,
        signed_field_names: EPAY_SIGNED_FIELDS.join(","),
      };
      fields.signature = await esewaSign(secret, fields, EPAY_SIGNED_FIELDS);
      return { kind: "form", action: formUrl, method: "POST", fields };
    },

    /**
     * Authoritative check via the status API. If `callback.data` is present (success redirect)
     * its signature is verified too. `amountPaisa` MUST be the TOTAL you charged
     * (amount + tax + charges): eSewa returns NOT_FOUND for a wrong total, which doubles as an
     * amount check.
     */
    async verify({ orderId, amountPaisa, callback }: VerifyInput): Promise<VerifyResult> {
      let signatureValid: boolean | undefined;
      if (callback?.data) signatureValid = await checkSuccessCallback(callback.data, orderId);
      const s = await statusCheck(orderId, amountPaisa);
      return {
        provider: "esewa",
        status: lookup(EPAY_STATUS, String(s.status)) ?? "unknown",
        orderId,
        amountPaisa: isRupeeAmount(s.total_amount) ? rupeesToPaisa(s.total_amount) : null,
        transactionId: stringOrNull(s.ref_id),
        raw: { status: s, signatureValid },
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      if (params.data) {
        try {
          const payload = base64Json(params.data);
          const uuid = isRecord(payload) ? payload.transaction_uuid : undefined;
          return String(uuid ?? "") || null;
        } catch {
          return null;
        }
      }
      // from your path param on failure_url
      return params.orderId || params.order_id || params.transaction_uuid || null;
    },

    parseSuccess,

    // ------------------------------------------------------------ Intent (mobile app-to-app)

    /**
     * Book an Intent payment. Open `deeplink` in the app (or mobile browser); eSewa app handles
     * payment. Persist bookingId + correlationId on the attempt (as providerRef, e.g.
     * `${bookingId}|${correlationId}`).
     * Use whole-rupee amounts: decimal amount signing for Intent is not documented.
     */
    async intentBook(input: EsewaIntentBookInput) {
      const intent = requireIntent();
      assertPaisa(input.amountPaisa, "esewa");
      const amount = Number(paisaToRupees(input.amountPaisa));
      const signed = await signedIntentBody(
        intent.accessKey,
        {
          product_code: intent.productCode,
          amount: String(amount),
          transaction_uuid: input.orderId,
        },
        ["product_code", "amount", "transaction_uuid"],
      );
      const body = {
        product_code: intent.productCode,
        amount, // sent as a number, signed as String(amount)
        transaction_uuid: input.orderId,
        signed_field_names: signed.signed_field_names,
        signature: signed.signature,
        callback_url: input.callbackUrl,
        redirect_url: input.redirectUrl,
        properties: input.properties ?? { remarks: input.orderId },
      };
      const res = await http("esewa", `${intent.baseUrl}/book`, {
        method: "POST",
        body,
        timeoutMs,
      });
      const booking = intentBookingFrom(res.data);
      if (!booking) throw esewaError(res, "eSewa intent book failed");
      return {
        bookingId: booking.booking_id,
        deeplink: booking.deeplink,
        correlationId: booking.correlation_id,
        providerRef: `${booking.booking_id}|${booking.correlation_id}`,
        raw: res.data,
      };
    },

    /**
     * Authoritative Intent status. `providerRef` = "bookingId|correlationId" stored at booking.
     * Pass the stored amount: the status response has none, but the amount was signed at booking.
     */
    async intentVerify(
      orderId: string,
      providerRef: string,
      amountPaisa?: number,
    ): Promise<VerifyResult> {
      const intent = requireIntent();
      const [bookingId, correlationId] = providerRef.split("|");
      const body = await signedIntentBody(
        intent.accessKey,
        { booking_id: bookingId, product_code: intent.productCode, correlation_id: correlationId },
        ["booking_id", "product_code", "correlation_id"],
      );
      const res = await http("esewa", `${intent.baseUrl}/status`, {
        method: "POST",
        body,
        timeoutMs,
        retries: 2,
      });
      const data = intentStatusFrom(res.data);
      if (!data) throw esewaError(res, "eSewa intent status failed");
      if (data.transaction_id && data.transaction_id !== orderId) {
        throw new PaymentError(
          "eSewa intent: status is for a different transaction",
          "esewa",
          "callback_mismatch",
          400,
          data,
        );
      }
      return {
        provider: "esewa",
        status: lookup(INTENT_STATUS, String(data.status)) ?? "unknown",
        orderId,
        // Status response has no amount: the amount was fixed and signed at booking time.
        amountPaisa: amountPaisa ?? null,
        transactionId: stringOrNull(data.reference_code),
        raw: res.data,
      };
    },

    /** Cancel a booking that hasn't completed (e.g. user abandoned). */
    async intentCancel(providerRef: string): Promise<unknown> {
      const intent = requireIntent();
      const [bookingId] = providerRef.split("|");
      const body = await signedIntentBody(
        intent.accessKey,
        { booking_id: bookingId, product_code: intent.productCode },
        ["booking_id", "product_code"],
      );
      const res = await http("esewa", `${intent.baseUrl}/cancel`, {
        method: "POST",
        body,
        timeoutMs,
      });
      return res.data;
    },

    /**
     * Verify the signature on eSewa's Intent callback POST body. Still call intentVerify() before
     * fulfilling. Prefer the RAW request body (string): numbers are then also checked exactly as
     * eSewa sent them ("100.0"), not only as String(v) ("100"). A parsed object can only be
     * checked in the String(v) form.
     */
    async intentCallbackValid(body: Record<string, unknown> | string): Promise<boolean> {
      const intent = requireIntent();
      const text = typeof body === "string" ? body : undefined;
      let payload: unknown;
      try {
        payload = text === undefined ? body : JSON.parse(text);
      } catch {
        return false;
      }
      if (!isRecord(payload)) return false;
      const names = lookup(payload, "signed_field_names");
      const signature = lookup(payload, "signature");
      if (typeof names !== "string" || typeof signature !== "string") return false;

      const order = parseFieldNames(names);
      const asString = stringFields(payload, order);
      if (safeEqual(await esewaSign(intent.accessKey, asString, order), signature)) return true;
      if (text === undefined) return false;

      // Only worth a second HMAC when the raw text differs from the String(v) form.
      const exact = rawFields(text, payload, order);
      if (!order.some((f) => exact[f] !== asString[f])) return false;
      return safeEqual(await esewaSign(intent.accessKey, exact, order), signature);
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
