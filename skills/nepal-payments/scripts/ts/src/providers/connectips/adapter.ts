/**
 * connectIPS (NCHL) e-payment gateway —
 * https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
 * Onboarding via your bank -> NCHL emails MERCHANTID, APPID, APPNAME, app password and the
 * creditor .pfx.
 *
 * Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to
 *       loginpage -> connectIPS redirects to your registered success/failure URL with
 *       ?TXNID=... -> validatetxn (Basic auth).
 *
 * Key prep (once):
 *   openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes [-legacy] \
 *     | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
 */
import { rsaSha256SignBase64 } from "../../core/crypto.ts";
import { PaymentError, responseError } from "../../core/errors.ts";
import { basicAuth, http } from "../../core/http.ts";
import { assertPaisa } from "../../core/money.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { ConnectIpsConfig } from "./config.ts";
import {
  BASE,
  LOGIN_PAGE_PATH,
  mapValidationStatus,
  validationUrl,
  type ValidationPath,
} from "./endpoints.ts";
import { isTxnDetail, txnAmountPaisa, type ConnectIpsTxnDetail } from "./responses.ts";
import { clip, connectIpsDate, connectIpsTokenString, validationTokenString } from "./signing.ts";

export type { ConnectIpsTxnDetail } from "./responses.ts";

export interface ConnectIpsInitiateExtras {
  referenceId?: string;
  remarks?: string;
  particulars?: string;
}

function assertTxnId(orderId: string): void {
  if (!/^[A-Za-z0-9-]{1,20}$/.test(orderId)) {
    throw new PaymentError(
      "connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]",
      "connectips",
      "invalid_order_id",
    );
  }
}

export function connectips(cfg: ConnectIpsConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const auth = { Authorization: basicAuth(cfg.appId, cfg.appPassword) };

  /** The form fields connectIPS signs, in token-string order (TOKEN is added after signing). */
  function gatewayFields(input: InitiateInput & ConnectIpsInitiateExtras): Record<string, string> {
    return {
      MERCHANTID: String(cfg.merchantId),
      APPID: cfg.appId,
      APPNAME: cfg.appName.slice(0, 30),
      TXNID: input.orderId,
      TXNDATE: connectIpsDate(),
      TXNCRNCY: "NPR",
      TXNAMT: String(input.amountPaisa), // PAISA
      REFERENCEID: clip(input.referenceId || input.orderId, 20),
      REMARKS: clip(input.remarks || input.description, 50) || "Payment",
      PARTICULARS: clip(input.particulars || input.description, 100) || "Payment",
    };
  }

  async function validationCall(
    path: ValidationPath,
    txnId: string,
    amountPaisa: number,
  ): Promise<ConnectIpsTxnDetail> {
    const tokenString = validationTokenString(cfg.merchantId, cfg.appId, txnId, amountPaisa);
    const body = {
      merchantId: Number(cfg.merchantId),
      appId: cfg.appId,
      referenceId: txnId, // NOTE: the TXNID you sent, not REFERENCEID
      txnAmt: amountPaisa,
      token: await rsaSha256SignBase64(cfg.privateKeyPem, tokenString),
    };
    const res = await http("connectips", validationUrl(base, path), {
      method: "POST",
      headers: auth,
      body,
      timeoutMs,
      retries: 2,
    });
    if (res.status === 401) {
      throw new PaymentError(
        "connectIPS: 401 — wrong APPID/app password",
        "connectips",
        "unauthorized",
        401,
      );
    }
    if (res.status !== 200 || !isTxnDetail(res.data)) {
      throw responseError("connectips", res, `connectIPS ${path} failed`);
    }
    return res.data;
  }

  const adapter = {
    id: "connectips" as const,

    /**
     * Form POST to the connectIPS login page. TXNID = orderId (<= 20 chars, unique per app).
     * Success/failure redirect URLs are REGISTERED WITH NCHL, not sent per request; returnUrl is
     * unused here.
     */
    async initiate(input: InitiateInput & ConnectIpsInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "connectips");
      assertTxnId(input.orderId);
      const fields = gatewayFields(input);
      fields.TOKEN = await rsaSha256SignBase64(cfg.privateKeyPem, connectIpsTokenString(fields));
      return { kind: "form", action: `${base}${LOGIN_PAGE_PATH}`, method: "POST", fields };
    },

    /** validatetxn — authoritative. SUCCESS + amount match = paid. */
    async verify({ orderId, amountPaisa }: VerifyInput): Promise<VerifyResult> {
      const r = await validationCall("validatetxn", orderId, amountPaisa);
      return {
        provider: "connectips",
        status: mapValidationStatus(r.status, r.statusDesc),
        orderId,
        amountPaisa: txnAmountPaisa(r.txnAmt),
        transactionId: null,
        raw: r,
      };
    },

    /**
     * Full detail incl. NCHL txnId, bank, charges and creditStatus
     * ("000"/"999"/"DEFER" = credited/OK).
     */
    getTxnDetail(orderId: string, amountPaisa: number) {
      return validationCall("gettxndetail", orderId, amountPaisa);
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.TXNID || params.txnId || null;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
