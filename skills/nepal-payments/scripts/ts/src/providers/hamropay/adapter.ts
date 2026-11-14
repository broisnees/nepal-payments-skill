/**
 * Hamro Pay Checkout (Hamro Patro's wallet) — https://hamropay.com.np/checkout/developer/reference/
 * Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000)
 * -> Client Credentials: merchantId, Client-Id, Client-API-Key, client secret;
 * Configuration -> Webhook gives the webhook signing secret.
 *
 * Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token
 *       -> browser form POST to {gateway}/api/checkout -> Hamro Pay redirects to success/failure
 *       URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
 *
 * transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is
 * RUPEES. Signature formats: see signing.ts.
 */
import { safeEqual } from "../../core/crypto.ts";
import { PaymentError } from "../../core/errors.ts";
import { http } from "../../core/http.ts";
import { assertPaisa, paisaToRupees, rupeesToPaisa } from "../../core/money.ts";
import { isRupeeAmount, lookup, nonEmptyString } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import { HAMROPAY_MAX_PAISA, HAMROPAY_MIN_PAISA, type HamroPayConfig } from "./config.ts";
import {
  API,
  CREATE_SESSION_PATH,
  GET_TRANSACTION_PATH,
  SANDBOX_GATEWAY,
  TXN_STATUS,
} from "./endpoints.ts";
import {
  bodyOrError,
  echoedTxnId,
  type CreateSessionResponse,
  type HamroPayBody,
} from "./responses.ts";
import { hamroPaySign, webhookAmountRenderings } from "./signing.ts";

export interface HamroPayInitiateExtras {
  remarks?: string;
  metadata?: Record<string, string>;
}

function assertInitiateInput(input: InitiateInput): void {
  if (input.amountPaisa < HAMROPAY_MIN_PAISA || input.amountPaisa > HAMROPAY_MAX_PAISA) {
    throw new PaymentError(
      "Hamro Pay accepts Rs 10 to Rs 50,000 per transaction",
      "hamropay",
      "invalid_amount",
    );
  }
  if (!/^[A-Za-z0-9-]{1,25}$/.test(input.orderId)) {
    throw new PaymentError(
      "Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]",
      "hamropay",
      "invalid_order_id",
    );
  }
}

/** Create Session body. transactionAmount is the same paisa string that is signed. */
function createSessionBody(
  input: InitiateInput & HamroPayInitiateExtras,
  merchantId: string,
  transactionAmount: string,
) {
  const name = input.description || "Payment";
  return {
    merchantTxnId: input.orderId,
    merchantId,
    transactionAmount,
    successRedirectionUrl: input.returnUrl,
    failedRedirectionUrl: input.failureUrl ?? input.returnUrl,
    productList: [
      {
        name,
        description: name,
        price: Number(paisaToRupees(input.amountPaisa)),
        quantity: 1,
      },
    ],
    ...(input.customer?.phone && { phone_number: input.customer.phone }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

export function hamropay(cfg: HamroPayConfig) {
  const api = (cfg.apiBaseUrl ?? API[cfg.env]).replace(/\/$/, "");
  const gateway = cfg.gatewayUrl ?? (cfg.env === "sandbox" ? SANDBOX_GATEWAY : undefined);
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  /** Signed POST. Returns the object body of a 200 answer; throws a PaymentError otherwise. */
  async function post(
    path: string,
    body: unknown,
    signed: (string | number)[],
    retries = 0,
  ): Promise<HamroPayBody> {
    const res = await http("hamropay", `${api}${path}`, {
      method: "POST",
      headers: {
        Signature: await hamroPaySign(cfg.clientSecret, signed),
        "Client-Id": cfg.clientId,
        "Client-API-Key": cfg.clientApiKey,
        // The API drops each TCP connection without marking it closed; a pooled keep-alive
        // socket then fails on the next call (Hamro Pay's own sample measured every second
        // request failing on UAT).
        Connection: "close",
      },
      body,
      timeoutMs,
      retries,
    });
    const result = bodyOrError(res, path);
    if (result instanceof PaymentError) throw result;
    return result;
  }

  /** Create Session; returns the sessionId after checking Hamro Pay answered for this merchant. */
  async function createSession(
    input: InitiateInput & HamroPayInitiateExtras,
    transactionAmount: string,
  ): Promise<string> {
    const session: CreateSessionResponse = await post(
      CREATE_SESSION_PATH,
      createSessionBody(input, cfg.merchantId, transactionAmount),
      [input.orderId, transactionAmount, cfg.merchantId, cfg.clientId, cfg.clientApiKey],
    );
    if (typeof session.sessionId !== "string" || !session.sessionId) {
      throw new PaymentError(
        "Hamro Pay: Create Session returned no sessionId",
        "hamropay",
        "no_session",
        200,
        session,
      );
    }
    if (session.merchantId != null && session.merchantId !== cfg.merchantId) {
      throw new PaymentError(
        "Hamro Pay: Create Session answered for a different merchantId",
        "hamropay",
        "merchant_mismatch",
        200,
        session,
      );
    }
    return session.sessionId;
  }

  const adapter = {
    id: "hamropay" as const,

    /**
     * Create Session, then the signed form for the gateway. merchantTxnId = orderId
     * (<= 25 chars). Persist providerRef (the sessionId). A session lives about 10 minutes.
     * A timeout here may still have created the session on Hamro Pay's side: retry with a NEW
     * orderId.
     */
    async initiate(input: InitiateInput & HamroPayInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "hamropay");
      assertInitiateInput(input);
      if (!gateway) {
        throw new Error(
          "hamropay: gatewayUrl is required in production (Hamro Pay issues the live gateway host)",
        );
      }
      const transactionAmount = String(input.amountPaisa); // signed and sent as the same string
      const sessionId = await createSession(input, transactionAmount);
      const token = await hamroPaySign(cfg.clientSecret, [
        cfg.merchantId,
        input.orderId,
        sessionId,
        transactionAmount,
        cfg.clientId,
        cfg.clientApiKey,
      ]);
      return {
        kind: "form",
        action: gateway,
        method: "POST",
        fields: {
          merchant_id: cfg.merchantId,
          session_id: sessionId,
          token,
          merchant_transaction_id: input.orderId,
          remarks: (input.remarks ?? input.description ?? "").slice(0, 250),
        },
        providerRef: sessionId,
      };
    },

    /** Get Transaction — authoritative. amount is rupees, and 0 until the payment finishes. */
    async verify({ orderId }: VerifyInput): Promise<VerifyResult> {
      const r = await post(
        GET_TRANSACTION_PATH,
        { merchantId: cfg.merchantId, merchantTxnId: orderId },
        [orderId, cfg.merchantId, cfg.clientId, cfg.clientApiKey],
        2,
      );
      const echoed = echoedTxnId(r);
      if (echoed != null && echoed !== "" && String(echoed) !== orderId) {
        throw new PaymentError(
          "Hamro Pay: transaction answer is for a different merchantTxnId",
          "hamropay",
          "id_mismatch",
          200,
          r,
        );
      }
      const status = lookup(TXN_STATUS, String(r.status ?? "").toUpperCase()) ?? "unknown";
      const paidAmount = status === "paid" && isRupeeAmount(r.amount) ? r.amount : null;
      return {
        provider: "hamropay",
        status,
        orderId,
        amountPaisa: paidAmount === null ? null : rupeesToPaisa(paidAmount),
        transactionId: nonEmptyString(r.trackingId) ?? null,
        raw: r,
      };
    },

    /** Success and failure redirects carry ?MerchantTxnId=<your orderId>. */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.MerchantTxnId || params.merchantTxnId || null;
    },

    /**
     * Check a webhook's "Signature" header. Hamro Pay signs its own rendering of the amount (a
     * double), which may be "1200", "1200.0" or "1200.00", so every form of the PARSED number is
     * tried. Fulfil only after verify().
     */
    async verifyWebhook(
      body: Record<string, unknown>,
      signature: string | null | undefined,
    ): Promise<boolean> {
      if (!cfg.webhookSecret)
        throw new Error("hamropay: webhookSecret required to verify webhooks");
      if (typeof signature !== "string" || !signature) return false;
      const amount = body.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
      const prefix: string[] = [];
      for (const value of [body.merchantTxnId, body.merchantId, body.status]) {
        if (typeof value !== "string" || !value || value.includes(",")) return false;
        prefix.push(value);
      }
      let ok = false;
      for (const rendering of webhookAmountRenderings(amount)) {
        const expected = await hamroPaySign(cfg.webhookSecret, [...prefix, rendering]);
        if (safeEqual(expected, signature)) ok = true;
      }
      return ok;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
