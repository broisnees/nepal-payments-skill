/**
 * Hamro Pay Checkout (Hamro Patro's wallet) — https://hamropay.com.np/checkout/developer/reference/
 * Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
 * merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook signing secret.
 *
 * Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
 *       {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
 *
 * Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
 *   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
 *   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
 *   get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
 *   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
 * transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
 */
import {
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

export interface HamroPayConfig {
  env: "sandbox" | "production";
  merchantId: string;
  clientId: string;
  clientApiKey: string;
  clientSecret: string;
  /** Signing secret shown when you save the webhook URL in the merchant portal. Needed for verifyWebhook(). */
  webhookSecret?: string;
  /** API host override. Default UAT https://uat-payclient.hamropatro.com, live https://payclient.hamropatro.com. */
  apiBaseUrl?: string;
  /** Full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay issues the live host. */
  gatewayUrl?: string;
  timeoutMs?: number;
}

const API = { sandbox: "https://uat-payclient.hamropatro.com", production: "https://payclient.hamropatro.com" } as const;
const SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout";
export const HAMROPAY_MIN_PAISA = 1000;
export const HAMROPAY_MAX_PAISA = 5_000_000;

const TXN_STATUS: Record<string, PaymentStatus> = {
  COMPLETED: "paid",
  FAILED: "failed",
  PENDING: "pending",
  PROCESSING: "pending",
  NOT_INITIATED: "not_found",
  CANCELED: "canceled",
  CANCELLED: "canceled",
};

/**
 * base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a value would let two
 * different tuples share a signature: refuse it instead.
 */
export async function hamroPaySign(secret: string, values: (string | number)[]): Promise<string> {
  if (values.some((v) => String(v).includes(","))) throw new Error("hamropay: signed values must not contain commas");
  return toBase64(await hmac("SHA-512", secret, values.join(",")));
}

export function hamropay(cfg: HamroPayConfig) {
  const api = (cfg.apiBaseUrl ?? API[cfg.env]).replace(/\/$/, "");
  const gateway = cfg.gatewayUrl ?? (cfg.env === "sandbox" ? SANDBOX_GATEWAY : undefined);
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  async function post<T>(path: string, body: unknown, signed: (string | number)[], retries = 0) {
    const res = await http<T & { code?: number; message?: string }>("hamropay", `${api}${path}`, {
      method: "POST",
      headers: {
        Signature: await hamroPaySign(cfg.clientSecret, signed),
        "Client-Id": cfg.clientId,
        "Client-API-Key": cfg.clientApiKey,
        // The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on the
        // next call (Hamro Pay's own sample measured every second request failing on UAT).
        Connection: "close",
      },
      body,
      timeoutMs,
      retries,
    });
    if (res.status === 401 || res.data?.code === 16) {
      throw new PaymentError("Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)", "hamropay", "unauthorized", res.status, res.data);
    }
    if (res.status !== 200 || !res.data || typeof res.data !== "object") {
      const msg = typeof res.data?.message === "string" ? res.data.message : res.text.slice(0, 200);
      throw new PaymentError(`Hamro Pay ${path} failed: ${msg}`, "hamropay", res.data?.code != null ? `code_${res.data.code}` : `http_${res.status}`, res.status, res.data);
    }
    return res.data;
  }

  const adapter = {
    id: "hamropay" as const,

    /**
     * Create Session, then the signed form for the gateway. merchantTxnId = orderId (<= 25 chars).
     * Persist providerRef (the sessionId). A session lives about 10 minutes.
     * A timeout here may still have created the session on Hamro Pay's side: retry with a NEW orderId.
     */
    async initiate(input: InitiateInput & { remarks?: string; metadata?: Record<string, string> }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "hamropay");
      if (input.amountPaisa < HAMROPAY_MIN_PAISA || input.amountPaisa > HAMROPAY_MAX_PAISA) {
        throw new PaymentError("Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", "hamropay", "invalid_amount");
      }
      if (!/^[A-Za-z0-9-]{1,25}$/.test(input.orderId)) {
        throw new PaymentError("Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]", "hamropay", "invalid_order_id");
      }
      if (!gateway) throw new Error("hamropay: gatewayUrl is required in production (Hamro Pay issues the live gateway host)");
      const transactionAmount = String(input.amountPaisa); // signed and sent as the same string
      const body = {
        merchantTxnId: input.orderId,
        merchantId: cfg.merchantId,
        transactionAmount,
        successRedirectionUrl: input.returnUrl,
        failedRedirectionUrl: input.failureUrl ?? input.returnUrl,
        productList: [{ name: input.description || "Payment", description: input.description || "Payment", price: Number(paisaToRupees(input.amountPaisa)), quantity: 1 }],
        ...(input.customer?.phone && { phone_number: input.customer.phone }),
        ...(input.metadata && { metadata: input.metadata }),
      };
      const session = await post<{ sessionId?: string; merchantId?: string }>(
        "/v1/checkout/sessionId",
        body,
        [input.orderId, transactionAmount, cfg.merchantId, cfg.clientId, cfg.clientApiKey],
      );
      if (typeof session.sessionId !== "string" || !session.sessionId) {
        throw new PaymentError("Hamro Pay: Create Session returned no sessionId", "hamropay", "no_session", 200, session);
      }
      if (session.merchantId != null && session.merchantId !== cfg.merchantId) {
        throw new PaymentError("Hamro Pay: Create Session answered for a different merchantId", "hamropay", "merchant_mismatch", 200, session);
      }
      const token = await hamroPaySign(cfg.clientSecret, [cfg.merchantId, input.orderId, session.sessionId, transactionAmount, cfg.clientId, cfg.clientApiKey]);
      return {
        kind: "form",
        action: gateway,
        method: "POST",
        fields: {
          merchant_id: cfg.merchantId,
          session_id: session.sessionId,
          token,
          merchant_transaction_id: input.orderId,
          remarks: (input.remarks ?? input.description ?? "").slice(0, 250),
        },
        providerRef: session.sessionId,
      };
    },

    /** Get Transaction — authoritative. amount is rupees, and 0 until the payment finishes. */
    async verify({ orderId }: VerifyInput): Promise<VerifyResult> {
      const r = await post<Record<string, unknown>>(
        "/v1/checkout/transaction",
        { merchantId: cfg.merchantId, merchantTxnId: orderId },
        [orderId, cfg.merchantId, cfg.clientId, cfg.clientApiKey],
        2,
      );
      // The reference names it merchantTransactionId; the live API answers merchantTxnId.
      const echoed = r.merchantTransactionId ?? r.merchantTxnId;
      if (echoed != null && echoed !== "" && String(echoed) !== orderId) {
        throw new PaymentError("Hamro Pay: transaction answer is for a different merchantTxnId", "hamropay", "id_mismatch", 200, r);
      }
      const status = lookup(TXN_STATUS, String(r.status ?? "").toUpperCase()) ?? "unknown";
      const amt = status === "paid" && r.amount != null ? rupeesToPaisa(r.amount as number | string) : null;
      return {
        provider: "hamropay",
        status,
        orderId,
        amountPaisa: amt,
        transactionId: typeof r.trackingId === "string" && r.trackingId ? r.trackingId : null,
        raw: r,
      };
    },

    /** Success and failure redirects carry ?MerchantTxnId=<your orderId>. */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.MerchantTxnId || params.merchantTxnId || null;
    },

    /**
     * Check a webhook's "Signature" header. Hamro Pay signs its own rendering of the amount (a double), which may be
     * "1200", "1200.0" or "1200.00", so every form of the PARSED number is tried. Fulfil only after verify().
     */
    async verifyWebhook(body: Record<string, unknown>, signature: string | null | undefined): Promise<boolean> {
      if (!cfg.webhookSecret) throw new Error("hamropay: webhookSecret required to verify webhooks");
      if (typeof signature !== "string" || !signature) return false;
      const amount = body.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
      const prefix = [body.merchantTxnId, body.merchantId, body.status];
      if (prefix.some((v) => typeof v !== "string" || !v || v.includes(","))) return false;
      let ok = false;
      for (const a of new Set([String(amount), amount.toFixed(2), `${amount}.0`, amount.toFixed(1)])) {
        if (safeEqual(await hamroPaySign(cfg.webhookSecret, [...(prefix as string[]), a]), signature)) ok = true;
      }
      return ok;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
