/**
 * eSewa — https://developer.esewa.com.np
 *
 * Two flows:
 *  1. ePay v2 (web, also works in a mobile WebView): signed form POST -> eSewa -> success_url?data=<base64 JSON>
 *     -> verify response signature -> status API (authoritative).
 *  2. Intent (mobile app-to-app, eSewa's recommended replacement for its deprecated mobile SDKs):
 *     server books -> app opens deeplink -> eSewa POSTs callback_url + redirects redirect_url -> status API.
 *
 * Signature (both): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in `signed_field_names` order.
 * NOTE: the example signatures printed in eSewa's docs are wrong; see the vectors in test/adapters.test.ts.
 */
import {
  base64Json,
  fromBase64,
  hmac,
  http,
  lookup,
  paisaToRupees,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  safeEqual,
  toBase64,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface EsewaConfig {
  env: "sandbox" | "production";
  /** ePay product code. Sandbox: "EPAYTEST". */
  productCode: string;
  /** ePay secret key. Sandbox: "8gBm/:&EnhH.1/q". Watch for HTML-escaping (&amp;) when loading from config UIs. */
  secretKey: string;
  /** Intent (mobile) credentials — only needed if you use intentBook(). Sandbox: "INTENT" / access key below. */
  intent?: { productCode: string; accessKey: string; baseUrl?: string };
  /** Override endpoints (e.g. if eSewa gives you different hosts at go-live). */
  formUrl?: string;
  statusUrl?: string;
  /** Throw when the success-redirect signature doesn't verify (default true). Status API is checked regardless. */
  strictSignature?: boolean;
  timeoutMs?: number;
}

export const ESEWA_SANDBOX = {
  productCode: "EPAYTEST",
  secretKey: "8gBm/:&EnhH.1/q",
  intent: { productCode: "INTENT", accessKey: "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==" }, // use as raw string, NOT base64-decoded
} as const;

const URLS = {
  sandbox: {
    form: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://rc.esewa.com.np/api/epay/transaction/status/",
    intent: "https://rc-checkout.esewa.com.np/api/client/intent/payment",
  },
  production: {
    form: "https://epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://esewa.com.np/api/epay/transaction/status/",
    intent: undefined, // eSewa provides the production Intent host at go-live — pass intent.baseUrl
  },
} as const;

const EPAY_STATUS: Record<string, PaymentStatus> = {
  COMPLETE: "paid",
  PENDING: "pending",
  AMBIGUOUS: "pending", // "payment is at halt state" — keep re-checking
  FULL_REFUND: "refunded",
  PARTIAL_REFUND: "partially_refunded",
  NOT_FOUND: "not_found", // session expired / never paid / wrong amount
  CANCELED: "canceled",
};

const INTENT_STATUS: Record<string, PaymentStatus> = {
  SUCCESS: "paid",
  BOOKED: "pending",
  PENDING: "pending",
  FAILED: "failed",
  CANCELED: "canceled",
  REVERTED: "refunded",
};

/** base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order. */
export async function esewaSign(key: string, fields: Record<string, string | number>, order: string[]): Promise<string> {
  const message = order.map((f) => `${f}=${fields[f] ?? ""}`).join(",");
  return toBase64(await hmac("SHA-256", key, message));
}

/** Error text from an eSewa error body: docs say `error_message`, the live Intent sandbox sends `errorMessage`. */
function errorMessage(data: any, text: string): string {
  return data?.error_message ?? data?.errorMessage ?? text.slice(0, 200);
}

/** `esewa_<code>` when the body carries a code, else `http_<status>`. */
function errorCode(data: any, status: number): string {
  return data?.code !== undefined && data?.code !== null ? `esewa_${data.code}` : `http_${status}`;
}

/** Exact text of a field as eSewa sent it, so numbers keep their formatting ("1000.0" stays "1000.0"). */
function rawValue(text: string, payload: Record<string, unknown>, field: string): string {
  const v = lookup(payload, field);
  if (typeof v !== "number") return String(v ?? "");
  const safe = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`"${safe}"\\s*:\\s*(-?[0-9][0-9.eE+-]*)`));
  return m ? m[1] : String(v);
}

export interface EsewaSuccessPayload {
  transaction_code: string;
  status: string;
  total_amount: string | number;
  transaction_uuid: string;
  product_code: string;
  signed_field_names: string;
  signature: string;
  [k: string]: unknown;
}

export interface EsewaInitiateExtras {
  /**
   * Optional breakdown, INCLUDED in amountPaisa. amountPaisa is always the TOTAL charged — the number you
   * store and later pass to verify(). eSewa's `amount` field = amountPaisa - tax - service - delivery.
   */
  taxPaisa?: number;
  serviceChargePaisa?: number;
  deliveryChargePaisa?: number;
}

export function esewa(cfg: EsewaConfig) {
  const urls = URLS[cfg.env];
  const formUrl = cfg.formUrl ?? urls.form;
  const statusUrl = cfg.statusUrl ?? urls.status;
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const strict = cfg.strictSignature ?? true;
  const secret = cfg.secretKey.replace(/&amp;/g, "&");

  /** Decode + verify the base64 `data` param from success_url. Does NOT prove payment; call verify(). */
  async function parseSuccess(data: string): Promise<{ payload: EsewaSuccessPayload; signatureValid: boolean }> {
    let text: string;
    let payload: EsewaSuccessPayload;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(data));
      payload = JSON.parse(text) as EsewaSuccessPayload;
    } catch {
      throw new PaymentError("eSewa: success data is not base64 JSON", "esewa", "malformed_callback", 400, data);
    }
    if (!payload || typeof payload !== "object" || typeof payload.signed_field_names !== "string") {
      throw new PaymentError("eSewa: malformed success payload", "esewa", "malformed_callback", 400, payload);
    }
    const order = payload.signed_field_names.split(",").map((s) => s.trim());
    const fields = Object.fromEntries(order.map((f) => [f, rawValue(text, payload, f)]));
    const expected = await esewaSign(secret, fields, order);
    let ok = typeof payload.signature === "string" && safeEqual(expected, payload.signature);
    // eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed. Try both.
    if (!ok && fields.total_amount?.includes(",")) {
      const alt = await esewaSign(secret, { ...fields, total_amount: fields.total_amount.replace(/,/g, "") }, order);
      ok = safeEqual(alt, payload.signature);
    }
    return { payload, signatureValid: ok };
  }

  async function statusCheck(orderId: string, amountPaisa: number) {
    const qs = new URLSearchParams({
      product_code: cfg.productCode,
      total_amount: paisaToRupees(amountPaisa),
      transaction_uuid: orderId,
    });
    const res = await http<Record<string, any>>("esewa", `${statusUrl}?${qs}`, { timeoutMs, retries: 2 });
    if (res.status !== 200 || !res.data || typeof res.data !== "object" || !("status" in res.data)) {
      throw new PaymentError(`eSewa status check failed: ${errorMessage(res.data, res.text)}`, "esewa", errorCode(res.data, res.status), res.status, res.data);
    }
    return res.data as { product_code: string; transaction_uuid: string; total_amount: number; status: string; ref_id: string | null };
  }

  const adapter = {
    id: "esewa" as const,

    /**
     * Returns a form to auto-submit (application/x-www-form-urlencoded POST).
     * Keep `returnUrl`/`failureUrl` free of query strings — eSewa appends `?data=...`.
     * Put your attempt id in the PATH (e.g. /payments/esewa/return/<orderId>) so failures can be matched too.
     */
    async initiate(input: InitiateInput & EsewaInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "esewa");
      if (!/^[A-Za-z0-9-]+$/.test(input.orderId)) {
        throw new PaymentError("eSewa transaction_uuid allows only letters, digits and '-'", "esewa", "invalid_order_id");
      }
      const tax = input.taxPaisa ?? 0;
      const svc = input.serviceChargePaisa ?? 0;
      const del = input.deliveryChargePaisa ?? 0;
      const base = input.amountPaisa - tax - svc - del; // amountPaisa is the TOTAL charged
      if (![tax, svc, del].every((n) => Number.isSafeInteger(n) && n >= 0) || base <= 0) {
        throw new PaymentError("eSewa: tax/charges must be non-negative paisa and less than the total", "esewa", "invalid_amount");
      }
      // Format ONCE and use the same strings in the form and in the signature ("110" vs "110.0" -> ES104).
      const fields: Record<string, string> = {
        amount: paisaToRupees(base),
        tax_amount: paisaToRupees(tax),
        product_service_charge: paisaToRupees(svc),
        product_delivery_charge: paisaToRupees(del),
        total_amount: paisaToRupees(input.amountPaisa),
        transaction_uuid: input.orderId,
        product_code: cfg.productCode,
        success_url: input.returnUrl,
        failure_url: input.failureUrl ?? input.returnUrl,
        signed_field_names: "total_amount,transaction_uuid,product_code",
      };
      fields.signature = await esewaSign(secret, fields, ["total_amount", "transaction_uuid", "product_code"]);
      return { kind: "form", action: formUrl, method: "POST", fields };
    },

    /**
     * Authoritative check via the status API. If `callback.data` is present (success redirect) its signature
     * is verified too. `amountPaisa` MUST be the TOTAL you charged (amount + tax + charges): eSewa returns
     * NOT_FOUND for a wrong total, which doubles as an amount check.
     */
    async verify({ orderId, amountPaisa, callback }: VerifyInput): Promise<VerifyResult> {
      let signatureValid: boolean | undefined;
      if (callback?.data) {
        const parsed = await parseSuccess(callback.data);
        signatureValid = parsed.signatureValid;
        if (parsed.payload.transaction_uuid !== orderId || parsed.payload.product_code !== cfg.productCode) {
          throw new PaymentError("eSewa: callback does not match this attempt", "esewa", "callback_mismatch", 400, parsed.payload);
        }
        if (!signatureValid && strict) {
          throw new PaymentError("eSewa: invalid response signature", "esewa", "invalid_signature", 400, parsed.payload);
        }
      }
      const s = await statusCheck(orderId, amountPaisa);
      return {
        provider: "esewa",
        status: lookup(EPAY_STATUS, s.status) ?? "unknown",
        orderId,
        amountPaisa: typeof s.total_amount === "number" || typeof s.total_amount === "string" ? rupeesToPaisa(s.total_amount) : null,
        transactionId: s.ref_id ?? null,
        raw: { status: s, signatureValid },
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      if (params.data) {
        try {
          return String((base64Json(params.data) as EsewaSuccessPayload).transaction_uuid ?? "") || null;
        } catch {
          return null;
        }
      }
      return params.orderId || params.order_id || params.transaction_uuid || null; // from your path param on failure_url
    },

    parseSuccess,

    // ------------------------------------------------------------------ Intent (mobile app-to-app)

    /**
     * Book an Intent payment. Open `deeplink` in the app (or mobile browser); eSewa app handles payment.
     * Persist bookingId + correlationId on the attempt (as providerRef, e.g. `${bookingId}|${correlationId}`).
     * Use whole-rupee amounts: decimal amount signing for Intent is not documented.
     */
    async intentBook(input: {
      orderId: string;
      amountPaisa: number;
      callbackUrl: string; // server-to-server POST from eSewa
      redirectUrl: string; // where the user lands after paying
      properties?: Record<string, string>; // snake_case keys; shown to the user
    }) {
      const intent = requireIntent();
      assertPaisa(input.amountPaisa, "esewa");
      const amount = Number(paisaToRupees(input.amountPaisa));
      const body = {
        product_code: intent.productCode,
        amount,
        transaction_uuid: input.orderId,
        signed_field_names: "product_code,amount,transaction_uuid",
        signature: await esewaSign(intent.accessKey, { product_code: intent.productCode, amount: String(amount), transaction_uuid: input.orderId }, [
          "product_code",
          "amount",
          "transaction_uuid",
        ]),
        callback_url: input.callbackUrl,
        redirect_url: input.redirectUrl,
        properties: input.properties ?? { remarks: input.orderId },
      };
      const res = await http<any>("esewa", `${intent.baseUrl}/book`, { method: "POST", body, timeoutMs });
      if (!res.data?.data?.booking_id) {
        throw new PaymentError(`eSewa intent book failed: ${errorMessage(res.data, res.text)}`, "esewa", errorCode(res.data, res.status), res.status, res.data);
      }
      const d = res.data.data as { booking_id: string; deeplink: string; correlation_id: string };
      return { bookingId: d.booking_id, deeplink: d.deeplink, correlationId: d.correlation_id, providerRef: `${d.booking_id}|${d.correlation_id}`, raw: res.data };
    },

    /**
     * Authoritative Intent status. `providerRef` = "bookingId|correlationId" stored at booking.
     * Pass the stored amount: the status response has none, but the amount was signed at booking.
     */
    async intentVerify(orderId: string, providerRef: string, amountPaisa?: number): Promise<VerifyResult> {
      const intent = requireIntent();
      const [booking_id, correlation_id] = providerRef.split("|");
      const fields = { booking_id, product_code: intent.productCode, correlation_id };
      const order = ["booking_id", "product_code", "correlation_id"];
      const body = { ...fields, signed_field_names: order.join(","), signature: await esewaSign(intent.accessKey, fields, order) };
      const res = await http<any>("esewa", `${intent.baseUrl}/status`, { method: "POST", body, timeoutMs, retries: 2 });
      const d = res.data?.data;
      if (!d?.status) {
        throw new PaymentError(`eSewa intent status failed: ${errorMessage(res.data, res.text)}`, "esewa", errorCode(res.data, res.status), res.status, res.data);
      }
      if (d.transaction_id && d.transaction_id !== orderId) {
        throw new PaymentError("eSewa intent: status is for a different transaction", "esewa", "callback_mismatch", 400, d);
      }
      // Status response has no amount: the amount was fixed and signed at booking time.
      return { provider: "esewa", status: lookup(INTENT_STATUS, d.status) ?? "unknown", orderId, amountPaisa: amountPaisa ?? null, transactionId: d.reference_code ?? null, raw: res.data };
    },

    /** Cancel a booking that hasn't completed (e.g. user abandoned). */
    async intentCancel(providerRef: string) {
      const intent = requireIntent();
      const [booking_id] = providerRef.split("|");
      const fields = { booking_id, product_code: intent.productCode };
      const order = ["booking_id", "product_code"];
      const body = { ...fields, signed_field_names: order.join(","), signature: await esewaSign(intent.accessKey, fields, order) };
      const res = await http<any>("esewa", `${intent.baseUrl}/cancel`, { method: "POST", body, timeoutMs });
      return res.data;
    },

    /**
     * Verify the signature on eSewa's Intent callback POST body. Still call intentVerify() before fulfilling.
     * Prefer the RAW request body (string): numbers are then also checked exactly as eSewa sent them ("100.0"),
     * not only as String(v) ("100"). A parsed object can only be checked in the String(v) form.
     */
    async intentCallbackValid(body: Record<string, unknown> | string): Promise<boolean> {
      const intent = requireIntent();
      const text = typeof body === "string" ? body : undefined;
      let payload: Record<string, unknown>;
      try {
        payload = text === undefined ? body as Record<string, unknown> : JSON.parse(text);
      } catch {
        return false;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const names = lookup(payload, "signed_field_names");
      const signature = lookup(payload, "signature");
      if (typeof names !== "string" || typeof signature !== "string") return false;
      const order = names.split(",").map((s) => s.trim());
      const asString = Object.fromEntries(order.map((f) => [f, String(lookup(payload, f) ?? "")]));
      if (safeEqual(await esewaSign(intent.accessKey, asString, order), signature)) return true;
      if (text === undefined) return false;
      const exact = Object.fromEntries(order.map((f) => [f, rawValue(text, payload, f)]));
      return order.some((f) => exact[f] !== asString[f]) && safeEqual(await esewaSign(intent.accessKey, exact, order), signature);
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  function requireIntent() {
    if (!cfg.intent) throw new Error("eSewa: configure `intent` credentials to use Intent payments");
    const baseUrl = cfg.intent.baseUrl ?? urls.intent;
    if (!baseUrl) throw new Error("eSewa: production Intent baseUrl is issued by eSewa at go-live; set intent.baseUrl");
    return { ...cfg.intent, baseUrl };
  }

  return adapter;
}
