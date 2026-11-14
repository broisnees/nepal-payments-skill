/**
 * NEPALPAY QR (NCHL) merchant dynamic QR —
 * https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
 * Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI
 * username/password, and the signing .pfx (NPI.pfx in UAT).
 *
 * Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qrString / qrImage
 *       -> customer scans with any NEPALPAY QR / mobile banking app
 *       -> poll /nQR/v1/merchanttxnreport by validationTraceId (= providerRef).
 *
 * Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
 */
import {
  rsaPkcs1EncryptBase64,
  rsaSha256SignBase64,
  rsaSha256VerifyBase64,
} from "../../core/crypto.ts";
import { PaymentError, responseError } from "../../core/errors.ts";
import { basicAuth, http } from "../../core/http.ts";
import { assertPaisa, rupeesToPaisa } from "../../core/money.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  PaymentStatus,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { NepalPayConfig } from "./config.ts";
import {
  BASE,
  CREDIT_OK,
  DEBIT_OK,
  GENERATE_QR_PATH,
  NPR,
  OAUTH_TOKEN_PATH,
  QR_OK,
  REPORT_NOT_FOUND,
  REPORT_OK,
  TXN_REPORT_PATH,
  WS_SEND,
  WS_SUBSCRIBE,
} from "./endpoints.ts";
import {
  generatedQrFrom,
  generateQrErrorCode,
  oauthTokenFrom,
  reportCode,
  reportRows,
  type NepalPayTxn,
} from "./responses.ts";
import {
  confirmationReplyString,
  nepalPayConfirmationString,
  nepalPayTokenString,
  transactionAmount,
} from "./signing.ts";

export type { NepalPayTxn } from "./responses.ts";

/** The fields of a confirm-payment notification our signed reply echoes. */
export interface NepalPayConfirmation {
  txnDate: string;
  merchantBillNo: string;
  paymentRef: string;
}

function assertBillNumber(orderId: string): void {
  if (!/^[A-Za-z0-9-]{1,25}$/.test(orderId)) {
    throw new PaymentError(
      "NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]",
      "nepalpay",
      "invalid_order_id",
    );
  }
}

/** A QR can be scanned again after a failed attempt, so look at every payment row on it. */
function statusFromReport(txns: NepalPayTxn[]): { status: PaymentStatus; pick?: NepalPayTxn } {
  const payments = txns.filter((t) => (t.tranType ?? "PMT") === "PMT");
  const paid = payments.find(
    (t) => t.debitStatus === DEBIT_OK && CREDIT_OK.has(String(t.creditStatus)),
  );
  if (paid) return { status: "paid", pick: paid };
  const last = payments.at(-1);
  if (!last) return { status: "not_found" };
  // debited but credit not confirmed: review
  if (last.debitStatus === DEBIT_OK) return { status: "unknown", pick: last };
  return { status: "failed", pick: last };
}

export function nepalpay(cfg: NepalPayConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  let cachedToken: { token: string; until: number } | null = null;

  /** OAuth password grant; the bearer token is cached until 30 s before it expires. */
  async function oauthBearer(clientId: string, clientSecret: string): Promise<string> {
    if (cachedToken && cachedToken.until > Date.now()) return `Bearer ${cachedToken.token}`;
    const body = new URLSearchParams({
      grant_type: "password",
      username: cfg.username,
      password: cfg.password,
    }).toString();
    const res = await http("nepalpay", `${base}${OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      timeoutMs,
    });
    const token = res.status === 200 ? oauthTokenFrom(res.data) : undefined;
    if (!token) {
      throw responseError("nepalpay", res, "NEPALPAY oauth failed", { code: "unauthorized" });
    }
    const ttlSeconds = Number(token.expiresIn) || 60;
    const until = Date.now() + Math.max(ttlSeconds - 30, 5) * 1000;
    cachedToken = { token: token.accessToken, until };
    return `Bearer ${cachedToken.token}`;
  }

  async function authHeader(): Promise<string> {
    if ((cfg.auth ?? "basic") === "basic") return basicAuth(cfg.username, cfg.password);
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('nepalpay: clientId/clientSecret required for auth "oauth"');
    }
    return oauthBearer(cfg.clientId, cfg.clientSecret);
  }

  async function generateQrBody(input: InitiateInput) {
    const amount = transactionAmount(input.amountPaisa);
    const token = await rsaSha256SignBase64(
      cfg.privateKeyPem,
      nepalPayTokenString({
        acquirerId: cfg.acquirerId,
        merchantId: cfg.merchantId,
        merchantCategoryCode: cfg.merchantCategoryCode,
        transactionCurrency: NPR,
        transactionAmount: amount,
        billNumber: input.orderId,
        userId: cfg.username,
      }),
    );
    return {
      pointOfInitialization: 12, // 12 = dynamic QR
      acquirerId: cfg.acquirerId,
      merchantId: cfg.merchantId,
      merchantName: cfg.merchantName.slice(0, 25),
      merchantCategoryCode: Number(cfg.merchantCategoryCode),
      merchantCountry: "NP",
      merchantCity: cfg.merchantCity,
      merchantPostalCode: cfg.merchantPostalCode,
      merchantLanguage: "en",
      transactionCurrency: NPR,
      transactionAmount: amount,
      valueOfConvenienceFeeFixed: "0.00",
      billNumber: input.orderId,
      storeLabel: cfg.storeLabel,
      terminalLabel: cfg.terminalLabel ?? "0",
      purposeOfTransaction: (input.description || "Payment").slice(0, 25),
      qrImage: cfg.qrImage ?? true,
      token,
    };
  }

  const adapter = {
    id: "nepalpay" as const,

    /**
     * Dynamic QR. billNumber = orderId (<= 25 chars). Persist `providerRef` (validationTraceId):
     * verify() needs it. returnUrl is unused: there is no redirect, the payer scans the QR from
     * their own app.
     */
    async initiate(input: InitiateInput): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "nepalpay");
      assertBillNumber(input.orderId);
      const body = await generateQrBody(input);
      const res = await http("nepalpay", `${base}${GENERATE_QR_PATH}`, {
        method: "POST",
        headers: { Authorization: await authHeader() },
        body,
        timeoutMs,
      });
      const qr = generatedQrFrom(res.data, QR_OK);
      if (!qr) {
        throw responseError("nepalpay", res, "NEPALPAY generateQR failed", {
          detail: res.text.slice(0, 300),
          code: generateQrErrorCode(res.data, res.status),
        });
      }
      return {
        kind: "qr",
        qrString: qr.qrString,
        ...(qr.qrImage && { qrImage: qr.qrImage }),
        providerRef: qr.validationTraceId,
        raw: res.data,
      };
    },

    /** Every payment made against one QR (a failed scan can be retried on the same QR). */
    async report(validationTraceId: string): Promise<NepalPayTxn[]> {
      const body = { validationTraceId, merchantId: cfg.merchantId, acquirerId: cfg.acquirerId };
      const res = await http("nepalpay", `${base}${TXN_REPORT_PATH}`, {
        method: "POST",
        headers: { Authorization: await authHeader() },
        body,
        timeoutMs,
        retries: 2,
      });
      if (res.status === 401) {
        throw new PaymentError(
          "NEPALPAY: 401 — wrong NPI username/password",
          "nepalpay",
          "unauthorized",
          401,
          res.data,
        );
      }
      const code = reportCode(res.data);
      if (code === REPORT_NOT_FOUND) return []; // record not found
      if (!REPORT_OK.includes(code)) {
        throw responseError("nepalpay", res, "NEPALPAY report failed", {
          code: code || `http_${res.status}`,
        });
      }
      return reportRows(res.data);
    },

    /** merchanttxnreport by validationTraceId — authoritative. */
    async verify({ orderId, providerRef }: VerifyInput): Promise<VerifyResult> {
      if (!providerRef) {
        throw new PaymentError(
          "NEPALPAY verify needs providerRef (validationTraceId)",
          "nepalpay",
          "missing_provider_ref",
        );
      }
      const txns = await adapter.report(providerRef);
      const { status, pick } = statusFromReport(txns);
      return {
        provider: "nepalpay",
        status,
        orderId,
        amountPaisa: pick?.amount != null ? rupeesToPaisa(pick.amount) : null,
        transactionId: pick?.nQrTxnId ?? null,
        raw: txns,
      };
    },

    /**
     * Your orderId from a confirm-payment notification
     * (merchantBillNo = the billNumber you sent).
     */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.merchantBillNo || params.billNumber || null;
    },

    /**
     * Check a confirm-payment notification's signature with nchlPublicKeyPem. NCHL doesn't say
     * which key signs it, so a false here is a reason to log and alert, not proof of forgery.
     * Fulfil only after verify() either way.
     */
    async verifyConfirmation(n: Record<string, unknown>): Promise<boolean> {
      if (!cfg.nchlPublicKeyPem) {
        throw new Error("nepalpay: nchlPublicKeyPem required to verify notifications");
      }
      if (typeof n.signature !== "string") return false;
      const message = nepalPayConfirmationString(n);
      return rsaSha256VerifyBase64(cfg.nchlPublicKeyPem, message, n.signature);
    },

    /**
     * Everything a STOMP client needs to watch one QR live: connect to `url`, subscribe to
     * `subscribe`, then send `body` as JSON to `send`. Statuses arrive as ENTR, PARSED, then
     * COMPLETED or FAILED. On COMPLETED, call verify().
     */
    async webSocketRequest(validationTraceId: string) {
      const { wsUrl, wsUsername, wsApiToken, nchlPublicKeyPem } = cfg;
      if (!wsUrl || !wsUsername || !wsApiToken || !nchlPublicKeyPem) {
        throw new Error(
          "nepalpay: wsUrl, wsUsername, wsApiToken and nchlPublicKeyPem required for the " +
            "WebSocket channel",
        );
      }
      return {
        url: wsUrl,
        subscribe: WS_SUBSCRIBE,
        send: WS_SEND,
        body: {
          merchant_id: cfg.terminalLabel ?? "0",
          request_id: validationTraceId,
          username: wsUsername,
          api_token: await rsaPkcs1EncryptBase64(nchlPublicKeyPem, wsApiToken),
        },
      };
    },

    /**
     * Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.
     * The notification is a hint: call verify() before fulfilling.
     */
    async confirmationResponse(n: NepalPayConfirmation, ok = true) {
      const status = ok ? "SUCCESS" : "FAILED";
      const message = ok ? "TRANSACTION SUCCESSFUL" : "TRANSACTION FAILED";
      const reply = {
        txnDate: n.txnDate,
        status,
        message,
        merchantBillNo: n.merchantBillNo,
        paymentRef: n.paymentRef,
      };
      const signature = await rsaSha256SignBase64(
        cfg.privateKeyPem,
        confirmationReplyString(reply),
      );
      return { ...reply, signature };
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
