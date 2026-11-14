/**
 * Nepal Payment Solution (NPS / NPX) OnePG — one integration routes to ~29 banks'
 * mobile/e-banking, card checkout, and wallets (Khalti, MORU, MyPay, Hamro Pay...).
 * Source: "DEVELOPER GUIDELINES – API DOCUMENT – GATEWAY 2025" (given to merchants at onboarding).
 *
 * Auth: Basic base64(apiUsername:apiPassword) on every API call. Signature: see signing.ts.
 *
 * Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> payer pays
 *       -> NPS GETs your Notification URL (server-to-server) + browser returns to ResponseUrl
 *       -> CheckTransactionStatus (authoritative).
 */
import { PaymentError, responseError } from "../../core/errors.ts";
import { basicAuth, http } from "../../core/http.ts";
import { assertPaisa, paisaToRupees, rupeesToPaisa } from "../../core/money.ts";
import { isRecord, lookup, stringOrNull } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { NpsConfig } from "./config.ts";
import { NOT_INITIALIZED_ERROR_CODE, STATUS, URLS, type NpsOperation } from "./endpoints.ts";
import {
  isNpsResponse,
  npsEnvelopeError,
  type NpsInstrument,
  type NpsResponse,
  type NpsServiceCharge,
} from "./responses.ts";
import { npsSign } from "./signing.ts";

export function nps(cfg: NpsConfig) {
  const api = cfg.apiBaseUrl ?? URLS[cfg.env].api;
  const gateway = cfg.gatewayUrl ?? URLS[cfg.env].gateway;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const merchant = { MerchantId: cfg.merchantId, MerchantName: cfg.merchantName };

  /** Signed POST to an NPS operation. Throws unless the answer is an envelope with a code. */
  async function call<T>(
    operation: NpsOperation,
    payload: Record<string, string>,
    retries = 0,
  ): Promise<NpsResponse<T>> {
    const body = { ...payload, Signature: await npsSign(cfg.secretKey, payload) };
    const res = await http("nps", `${api}/${operation}`, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg.apiUsername, cfg.apiPassword) },
      body,
      timeoutMs,
      retries,
    });
    if (res.status === 401) {
      throw new PaymentError("NPS: 401 — wrong API username/password", "nps", "unauthorized", 401);
    }
    if (res.status !== 200 || !isNpsResponse<T>(res.data)) {
      throw responseError("nps", res, `NPS ${operation} failed`);
    }
    return res.data;
  }

  const notFound = (orderId: string, raw: unknown): VerifyResult => ({
    provider: "nps",
    status: "not_found",
    orderId,
    amountPaisa: null,
    transactionId: null,
    raw,
  });

  const adapter = {
    id: "nps" as const,

    /**
     * Optional: list banks/wallets to show your own picker; pass the chosen InstrumentCode to
     * initiate().
     */
    async getInstruments(): Promise<NpsInstrument[]> {
      const r = await call<NpsInstrument[]>("GetPaymentInstrumentDetails", merchant, 2);
      if (r.code !== "0") throw npsEnvelopeError("GetPaymentInstrumentDetails", r);
      return r.data;
    },

    /** Optional: NPS service charge for an amount + instrument. */
    async getServiceCharge(amountPaisa: number, instrumentCode: string): Promise<NpsServiceCharge> {
      const payload = {
        ...merchant,
        Amount: paisaToRupees(amountPaisa),
        InstrumentCode: instrumentCode,
      };
      const r = await call<NpsServiceCharge>("GetServiceCharge", payload, 2);
      if (r.code !== "0") throw npsEnvelopeError("GetServiceCharge", r);
      return r.data;
    },

    /**
     * GetProcessId + gateway form (multipart/form-data). `providerRef` = ProcessId (persist it).
     * The Notification URL (webhook) is configured with NPS at onboarding, not per request.
     */
    async initiate(input: InitiateInput & { instrumentCode?: string }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "nps");
      // the SAME string in GetProcessId and the form
      const Amount = paisaToRupees(input.amountPaisa);
      const r = await call<{ ProcessId?: unknown } | null>("GetProcessId", {
        ...merchant,
        Amount,
        MerchantTxnId: input.orderId,
      });
      const processId = isRecord(r.data) && r.data.ProcessId ? String(r.data.ProcessId) : "";
      if (r.code !== "0" || !processId) throw npsEnvelopeError("GetProcessId", r);
      const fields: Record<string, string> = {
        ...merchant,
        Amount,
        MerchantTxnId: input.orderId,
        ProcessId: processId,
        TransactionRemarks: input.description.slice(0, 100),
        ResponseUrl: input.returnUrl,
        // skips NPS's picker page
        ...(input.instrumentCode && { InstrumentCode: input.instrumentCode }),
      };
      return {
        kind: "form",
        action: gateway,
        method: "POST",
        enctype: "multipart/form-data",
        fields,
        providerRef: processId,
      };
    },

    /**
     * CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API
     * error.
     */
    async verify({ orderId }: VerifyInput): Promise<VerifyResult> {
      const r = await call<unknown>(
        "CheckTransactionStatus",
        { ...merchant, MerchantTxnId: orderId },
        2,
      );
      if (r.code !== "0") {
        if (r.errors?.some((e) => e.error_code === NOT_INITIALIZED_ERROR_CODE)) {
          return notFound(orderId, r);
        }
        throw npsEnvelopeError("CheckTransactionStatus", r);
      }
      // code "0" with a null/non-object data is malformed; report it as unknown rather than crash.
      const d: Record<string, unknown> = isRecord(r.data) ? r.data : {};
      if (d.MerchantTxnId && d.MerchantTxnId !== orderId) {
        throw new PaymentError(
          "NPS: status is for a different transaction",
          "nps",
          "callback_mismatch",
          400,
          d,
        );
      }
      return {
        provider: "nps",
        status: lookup(STATUS, String(d.Status ?? "").toLowerCase()) ?? "unknown",
        orderId,
        // excludes ServiceCharge
        amountPaisa: d.Amount ? rupeesToPaisa(String(d.Amount)) : null,
        transactionId: stringOrNull(d.GatewayReferenceNo),
        raw: r,
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.MerchantTxnId || null;
    },

    /**
     * Body to return from your Notification URL handler AFTER you've verified + recorded the
     * payment. NPS expects plain text "received" the first time and "already received" for
     * repeats.
     */
    notificationResponse(alreadyProcessed: boolean): string {
      return alreadyProcessed ? "already received" : "received";
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
