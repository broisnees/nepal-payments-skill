/**
 * Nepal Payment Solution (NPS / NPX) OnePG — one integration routes to ~29 banks' mobile/e-banking,
 * card checkout, and wallets (Khalti, MORU, MyPay, Hamro Pay...).
 * Source: "DEVELOPER GUIDELINES – API DOCUMENT – GATEWAY 2025" (given to merchants at onboarding).
 *
 * Auth: Basic base64(apiUsername:apiPassword) on every API call.
 * Signature: HMAC-SHA512(secretKey, values of payload keys sorted alphabetically (excluding Signature),
 *            concatenated with NO separator) as lowercase hex.
 *
 * Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> payer pays
 *       -> NPS GETs your Notification URL (server-to-server) + browser returns to ResponseUrl
 *       -> CheckTransactionStatus (authoritative).
 */
import {
  basicAuth,
  hmac,
  http,
  paisaToRupees,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  toHex,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface NpsConfig {
  env: "sandbox" | "production";
  merchantId: string;
  merchantName: string;
  apiUsername: string;
  apiPassword: string;
  secretKey: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  timeoutMs?: number;
}

const URLS = {
  sandbox: { api: "https://apisandbox.nepalpayment.com", gateway: "https://gatewaysandbox.nepalpayment.com/Payment/Index" },
  production: { api: "https://apigateway.nepalpayment.com", gateway: "https://gateway.nepalpayment.com/Payment/Index" },
} as const;

const STATUS: Record<string, PaymentStatus> = { success: "paid", fail: "failed", failed: "failed", pending: "pending" };

interface NpsResponse<T> {
  code: string; // "0" ok, "1" error
  message: string;
  errors: { error_code: string; error_message: string }[];
  data: T;
}

/** Sorted-keys, no-separator HMAC-SHA512 (lowercase hex). */
export async function npsSign(secretKey: string, payload: Record<string, string>): Promise<string> {
  const message = Object.keys(payload)
    .filter((k) => k !== "Signature")
    .sort()
    .map((k) => payload[k])
    .join("");
  return toHex(await hmac("SHA-512", secretKey, message));
}

export function nps(cfg: NpsConfig) {
  const api = cfg.apiBaseUrl ?? URLS[cfg.env].api;
  const gateway = cfg.gatewayUrl ?? URLS[cfg.env].gateway;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const merchant = { MerchantId: cfg.merchantId, MerchantName: cfg.merchantName };

  async function call<T>(path: string, payload: Record<string, string>, retries = 0): Promise<NpsResponse<T>> {
    const body = { ...payload, Signature: await npsSign(cfg.secretKey, payload) };
    const res = await http<NpsResponse<T>>("nps", `${api}/${path}`, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg.apiUsername, cfg.apiPassword) },
      body,
      timeoutMs,
      retries,
    });
    if (res.status === 401) throw new PaymentError("NPS: 401 — wrong API username/password", "nps", "unauthorized", 401);
    if (res.status !== 200 || !res.data || typeof res.data !== "object" || !("code" in res.data)) {
      throw new PaymentError(`NPS ${path} failed: ${res.text.slice(0, 200)}`, "nps", `http_${res.status}`, res.status, res.data);
    }
    return res.data;
  }

  const fail = (path: string, r: NpsResponse<unknown>) =>
    new PaymentError(
      `NPS ${path}: ${r.errors?.map((e) => e.error_message).join("; ") || r.message}`,
      "nps",
      r.errors?.[0]?.error_code ? `nps_${r.errors[0].error_code}` : "nps_error",
      200,
      r,
    );

  const adapter = {
    id: "nps" as const,

    /** Optional: list banks/wallets to show your own picker; pass the chosen InstrumentCode to initiate(). */
    async getInstruments() {
      const r = await call<{ InstitutionName: string; InstrumentName: string; InstrumentCode: string; BankType: string; LogoUrl: string }[]>(
        "GetPaymentInstrumentDetails",
        merchant,
        2,
      );
      if (r.code !== "0") throw fail("GetPaymentInstrumentDetails", r);
      return r.data;
    },

    /** Optional: NPS service charge for an amount + instrument. */
    async getServiceCharge(amountPaisa: number, instrumentCode: string) {
      const r = await call<{ Amount: string; CommissionType: string; ChargeValue: string; TotalChargeAmount: string }>(
        "GetServiceCharge",
        { ...merchant, Amount: paisaToRupees(amountPaisa), InstrumentCode: instrumentCode },
        2,
      );
      if (r.code !== "0") throw fail("GetServiceCharge", r);
      return r.data;
    },

    /**
     * GetProcessId + gateway form (multipart/form-data). `providerRef` = ProcessId (persist it).
     * The Notification URL (webhook) is configured with NPS at onboarding, not per request.
     */
    async initiate(input: InitiateInput & { instrumentCode?: string }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "nps");
      const Amount = paisaToRupees(input.amountPaisa); // the SAME string in GetProcessId and the form
      const r = await call<{ ProcessId: string }>("GetProcessId", { ...merchant, Amount, MerchantTxnId: input.orderId });
      if (r.code !== "0" || !r.data?.ProcessId) throw fail("GetProcessId", r);
      const fields: Record<string, string> = {
        ...merchant,
        Amount,
        MerchantTxnId: input.orderId,
        ProcessId: r.data.ProcessId,
        TransactionRemarks: input.description.slice(0, 100),
        ResponseUrl: input.returnUrl,
        ...(input.instrumentCode && { InstrumentCode: input.instrumentCode }), // skips NPS's picker page
      };
      return { kind: "form", action: gateway, method: "POST", enctype: "multipart/form-data", fields, providerRef: r.data.ProcessId };
    },

    /** CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API error. */
    async verify({ orderId }: VerifyInput): Promise<VerifyResult> {
      const r = await call<Record<string, string>>("CheckTransactionStatus", { ...merchant, MerchantTxnId: orderId }, 2);
      if (r.code !== "0") {
        // error_code "3" = "Transaction not initialized yet" (payer never reached the gateway)
        if (r.errors?.some((e) => e.error_code === "3")) {
          return { provider: "nps", status: "not_found", orderId, amountPaisa: null, transactionId: null, raw: r };
        }
        throw fail("CheckTransactionStatus", r);
      }
      const d = r.data;
      if (d.MerchantTxnId && d.MerchantTxnId !== orderId) {
        throw new PaymentError("NPS: status is for a different transaction", "nps", "callback_mismatch", 400, d);
      }
      return {
        provider: "nps",
        status: STATUS[(d.Status ?? "").toLowerCase()] ?? "unknown",
        orderId,
        amountPaisa: d.Amount ? rupeesToPaisa(d.Amount) : null, // excludes ServiceCharge
        transactionId: d.GatewayReferenceNo ?? null,
        raw: r,
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.MerchantTxnId || null;
    },

    /**
     * Body to return from your Notification URL handler AFTER you've verified + recorded the payment.
     * NPS expects plain text "received" the first time and "already received" for repeats.
     */
    notificationResponse(alreadyProcessed: boolean): string {
      return alreadyProcessed ? "already received" : "received";
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
