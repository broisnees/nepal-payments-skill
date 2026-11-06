/**
 * NEPALPAY QR (NCHL) merchant dynamic QR — https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
 * Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI username/password,
 * and the signing .pfx (NPI.pfx in UAT).
 *
 * Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qrString / qrImage -> customer scans with any
 *       NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= providerRef).
 *
 * Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
 * Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
 */
import {
  basicAuth,
  http,
  PaymentError,
  assertPaisa,
  rsaPkcs1EncryptBase64,
  rsaSha256SignBase64,
  rsaSha256VerifyBase64,
  rupeesToPaisa,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface NepalPayConfig {
  env: "sandbox" | "production";
  /** 8 digits, e.g. "00002501" (your acquiring bank). */
  acquirerId: string;
  /** Creditor id / merchant code, e.g. "2501ELFDRY2". */
  merchantId: string;
  /** <= 25 chars; must match the enrolled name. */
  merchantName: string;
  merchantCategoryCode: string | number;
  merchantCity: string;
  merchantPostalCode: string;
  storeLabel: string;
  terminalLabel?: string;
  /** NPI user issued to the merchant. Also the `userId` inside the signed token. */
  username: string;
  password: string;
  /** PKCS#8 PEM extracted from the NPI .pfx. */
  privateKeyPem: string;
  /** "basic" (merchant QR doc) or "oauth" (NPI password grant, needs clientId/clientSecret). Default "basic". */
  auth?: "basic" | "oauth";
  clientId?: string;
  clientSecret?: string;
  /** Ask NCHL for a base64 PNG alongside the QR string. Default true. */
  qrImage?: boolean;
  /** NCHL's public key (SPKI PEM, from NPI.cer): verifies confirm-payment notifications, encrypts the WebSocket api_token. */
  nchlPublicKeyPem?: string;
  /** WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own username and API token. */
  wsUrl?: string;
  wsUsername?: string;
  wsApiToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BASE = { sandbox: "https://devopennpi.connectips.com", production: "https://opennpi.connectips.com" } as const;
const NPR = 524;
const CREDIT_OK = new Set(["000", "999", "DEFER"]);

/** The exact string NCHL expects to be signed for a dynamic QR. */
export function nepalPayTokenString(f: {
  acquirerId: string;
  merchantId: string;
  merchantCategoryCode: string | number;
  transactionCurrency: string | number;
  transactionAmount: string;
  billNumber: string;
  userId: string;
}): string {
  return [f.acquirerId, f.merchantId, f.merchantCategoryCode, f.transactionCurrency, f.transactionAmount, f.billNumber, f.userId].join(",");
}

/** What NCHL signs on a confirm-payment notification. The docs name the field payerMobileNumber; the sample sends payerMobile. */
export function nepalPayConfirmationString(n: Record<string, unknown>): string {
  const v = (k: string) => (n[k] == null ? "" : String(n[k]));
  return [v("merchantBillNo"), v("merchantId"), v("merchantName"), v("paymentRef"), v("channel"), n.payerMobileNumber != null ? v("payerMobileNumber") : v("payerMobile"), v("sessionNo")].join(",");
}

export interface NepalPayTxn {
  nQrTxnId?: string;
  instructionId?: string;
  amount?: number;
  debitStatus?: string;
  creditStatus?: string;
  merchantBillNo?: string;
  payerName?: string;
  tranType?: string;
  [k: string]: unknown;
}

export function nepalpay(cfg: NepalPayConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  let cached: { token: string; until: number } | null = null;

  async function authHeader(): Promise<string> {
    if ((cfg.auth ?? "basic") === "basic") return basicAuth(cfg.username, cfg.password);
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("nepalpay: clientId/clientSecret required for auth \"oauth\"");
    if (cached && cached.until > Date.now()) return `Bearer ${cached.token}`;
    const body = new URLSearchParams({ grant_type: "password", username: cfg.username, password: cfg.password }).toString();
    const res = await http<any>("nepalpay", `${base}/oauth/token`, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg.clientId, cfg.clientSecret), "Content-Type": "application/x-www-form-urlencoded" },
      body,
      timeoutMs,
    });
    if (res.status !== 200 || !res.data?.access_token) {
      throw new PaymentError(`NEPALPAY oauth failed: ${res.text.slice(0, 200)}`, "nepalpay", "unauthorized", res.status, res.data);
    }
    const ttl = Number(res.data.expires_in) || 60;
    cached = { token: res.data.access_token, until: Date.now() + Math.max(ttl - 30, 5) * 1000 };
    return `Bearer ${cached.token}`;
  }

  const adapter = {
    id: "nepalpay" as const,

    /**
     * Dynamic QR. billNumber = orderId (<= 25 chars). Persist `providerRef` (validationTraceId): verify() needs it.
     * returnUrl is unused: there is no redirect, the payer scans the QR from their own app.
     */
    async initiate(input: InitiateInput): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "nepalpay");
      if (!/^[A-Za-z0-9-]{1,25}$/.test(input.orderId)) {
        throw new PaymentError("NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", "nepalpay", "invalid_order_id");
      }
      const transactionAmount = `${Math.trunc(input.amountPaisa / 100)}.${String(input.amountPaisa % 100).padStart(2, "0")}`; // always 2 decimals
      const token = await rsaSha256SignBase64(
        cfg.privateKeyPem,
        nepalPayTokenString({
          acquirerId: cfg.acquirerId,
          merchantId: cfg.merchantId,
          merchantCategoryCode: cfg.merchantCategoryCode,
          transactionCurrency: NPR,
          transactionAmount,
          billNumber: input.orderId,
          userId: cfg.username,
        }),
      );
      const body = {
        pointOfInitialization: 12,
        acquirerId: cfg.acquirerId,
        merchantId: cfg.merchantId,
        merchantName: cfg.merchantName.slice(0, 25),
        merchantCategoryCode: Number(cfg.merchantCategoryCode),
        merchantCountry: "NP",
        merchantCity: cfg.merchantCity,
        merchantPostalCode: cfg.merchantPostalCode,
        merchantLanguage: "en",
        transactionCurrency: NPR,
        transactionAmount,
        valueOfConvenienceFeeFixed: "0.00",
        billNumber: input.orderId,
        storeLabel: cfg.storeLabel,
        terminalLabel: cfg.terminalLabel ?? "0",
        purposeOfTransaction: (input.description || "Payment").slice(0, 25),
        qrImage: cfg.qrImage ?? true,
        token,
      };
      const res = await http<any>("nepalpay", `${base}/qr/generateQR`, {
        method: "POST",
        headers: { Authorization: await authHeader() },
        body,
        timeoutMs,
      });
      const data = res.data?.data;
      if (res.data?.responseCode !== "000" || !data?.qrString || !data?.validationTraceId) {
        const code = res.data?.responseCode ?? res.data?.responses?.[0]?.responseCode ?? `http_${res.status}`;
        throw new PaymentError(`NEPALPAY generateQR failed: ${res.text.slice(0, 300)}`, "nepalpay", String(code), res.status, res.data);
      }
      return {
        kind: "qr",
        qrString: String(data.qrString).trim(),
        ...(data.qrImage && { qrImage: String(data.qrImage) }),
        providerRef: String(data.validationTraceId),
        raw: res.data,
      };
    },

    /** Every payment made against one QR (a failed scan can be retried on the same QR). */
    async report(validationTraceId: string): Promise<NepalPayTxn[]> {
      const body = { validationTraceId, merchantId: cfg.merchantId, acquirerId: cfg.acquirerId };
      const res = await http<any>("nepalpay", `${base}/nQR/v1/merchanttxnreport`, {
        method: "POST",
        headers: { Authorization: await authHeader() },
        body,
        timeoutMs,
        retries: 2,
      });
      if (res.status === 401) throw new PaymentError("NEPALPAY: 401 — wrong NPI username/password", "nepalpay", "unauthorized", 401, res.data);
      const code = String(res.data?.responseCode ?? "");
      if (code === "E010") return []; // record not found
      if (code !== "200" && code !== "000") {
        throw new PaymentError(`NEPALPAY report failed: ${res.text.slice(0, 200)}`, "nepalpay", code || `http_${res.status}`, res.status, res.data);
      }
      return Array.isArray(res.data.responseBody) ? res.data.responseBody : [];
    },

    /** merchanttxnreport by validationTraceId — authoritative. */
    async verify({ orderId, providerRef }: VerifyInput): Promise<VerifyResult> {
      if (!providerRef) throw new PaymentError("NEPALPAY verify needs providerRef (validationTraceId)", "nepalpay", "missing_provider_ref");
      const txns = await adapter.report(providerRef);
      const payments = txns.filter((t) => (t.tranType ?? "PMT") === "PMT");
      const paid = payments.find((t) => t.debitStatus === "000" && CREDIT_OK.has(String(t.creditStatus)));
      const pick = paid ?? payments.at(-1);
      let status: VerifyResult["status"];
      if (paid) status = "paid";
      else if (!pick) status = "not_found";
      else if (pick.debitStatus === "000") status = "unknown"; // debited but credit not confirmed: review
      else status = "failed";
      const amt = pick?.amount != null ? rupeesToPaisa(pick.amount) : null;
      return {
        provider: "nepalpay",
        status,
        orderId,
        amountPaisa: amt,
        transactionId: pick?.nQrTxnId ?? null,
        raw: txns,
      };
    },

    /** Your orderId from a confirm-payment notification (merchantBillNo = the billNumber you sent). */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.merchantBillNo || params.billNumber || null;
    },

    /**
     * Check a confirm-payment notification's signature with nchlPublicKeyPem. NCHL doesn't say which key signs it, so
     * a false here is a reason to log and alert, not proof of forgery. Fulfil only after verify() either way.
     */
    async verifyConfirmation(n: Record<string, unknown>): Promise<boolean> {
      if (!cfg.nchlPublicKeyPem) throw new Error("nepalpay: nchlPublicKeyPem required to verify notifications");
      if (typeof n.signature !== "string") return false;
      return rsaSha256VerifyBase64(cfg.nchlPublicKeyPem, nepalPayConfirmationString(n), n.signature);
    },

    /**
     * Everything a STOMP client needs to watch one QR live: connect to `url`, subscribe to `subscribe`, then send
     * `body` as JSON to `send`. Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify().
     */
    async webSocketRequest(validationTraceId: string) {
      if (!cfg.wsUrl || !cfg.wsUsername || !cfg.wsApiToken || !cfg.nchlPublicKeyPem) {
        throw new Error("nepalpay: wsUrl, wsUsername, wsApiToken and nchlPublicKeyPem required for the WebSocket channel");
      }
      return {
        url: cfg.wsUrl,
        subscribe: "/user/nqrws/check-txn-status",
        send: "/nqrws/check-txn-status",
        body: {
          merchant_id: cfg.terminalLabel ?? "0",
          request_id: validationTraceId,
          username: cfg.wsUsername,
          api_token: await rsaPkcs1EncryptBase64(cfg.nchlPublicKeyPem, cfg.wsApiToken),
        },
      };
    },

    /**
     * Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.
     * The notification is a hint: call verify() before fulfilling.
     */
    async confirmationResponse(n: { txnDate: string; merchantBillNo: string; paymentRef: string }, ok = true) {
      const status = ok ? "SUCCESS" : "FAILED";
      const message = ok ? "TRANSACTION SUCCESSFUL" : "TRANSACTION FAILED";
      const tokenString = [n.txnDate, status, message, n.merchantBillNo, n.paymentRef].join(",");
      return {
        txnDate: n.txnDate,
        status,
        message,
        merchantBillNo: n.merchantBillNo,
        paymentRef: n.paymentRef,
        signature: await rsaSha256SignBase64(cfg.privateKeyPem, tokenString),
      };
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
