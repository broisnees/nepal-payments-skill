/**
 * connectIPS (NCHL) e-payment gateway — https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
 * Onboarding via your bank -> NCHL emails MERCHANTID, APPID, APPNAME, app password and the creditor .pfx.
 *
 * Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to loginpage
 *       -> connectIPS redirects to your registered success/failure URL with ?TXNID=... -> validatetxn (Basic auth).
 *
 * Key prep (once):  openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes [-legacy] | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
 */
import {
  basicAuth,
  http,
  PaymentError,
  assertPaisa,
  rsaSha256SignBase64,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface ConnectIpsConfig {
  env: "sandbox" | "production";
  merchantId: number | string;
  appId: string; // e.g. "MER-550-APP-1"
  appName: string; // <= 30 chars
  /** App password for Basic auth on validatetxn / gettxndetail. */
  appPassword: string;
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") extracted from the creditor .pfx. */
  privateKeyPem: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BASE = { sandbox: "https://uat.connectips.com", production: "https://login.connectips.com" } as const;

/** DD-MM-YYYY in Asia/Kathmandu. */
export function connectIpsDate(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("day")}-${get("month")}-${get("year")}`;
}

/** The exact string connectIPS expects to be signed for the gateway form. */
export function connectIpsTokenString(f: Record<string, string>): string {
  return (
    `MERCHANTID=${f.MERCHANTID},APPID=${f.APPID},APPNAME=${f.APPNAME},TXNID=${f.TXNID},TXNDATE=${f.TXNDATE},` +
    `TXNCRNCY=${f.TXNCRNCY},TXNAMT=${f.TXNAMT},REFERENCEID=${f.REFERENCEID},REMARKS=${f.REMARKS},` +
    `PARTICULARS=${f.PARTICULARS},TOKEN=TOKEN`
  );
}

export interface ConnectIpsTxnDetail {
  merchantId: number;
  appId: string;
  referenceId: string;
  txnAmt: string | number;
  status: "SUCCESS" | "FAILED" | "ERROR" | string;
  statusDesc: string;
  debitBankCode?: string;
  txnId?: number | string;
  batchId?: number | string;
  txnDate?: number;
  chargeAmt?: number;
  chargeLiability?: "MN" | "CG";
  creditStatus?: string;
  [k: string]: unknown;
}

const clip = (s: string, n: number) => s.replace(/[,=]/g, " ").slice(0, n); // commas/equals would corrupt the token string

export function connectips(cfg: ConnectIpsConfig) {
  const base = cfg.baseUrl ?? BASE[cfg.env];
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const auth = { Authorization: basicAuth(cfg.appId, cfg.appPassword) };

  async function validationCall(path: "validatetxn" | "gettxndetail", txnId: string, amountPaisa: number) {
    const tokenString = `MERCHANTID=${cfg.merchantId},APPID=${cfg.appId},REFERENCEID=${txnId},TXNAMT=${amountPaisa}`;
    const body = {
      merchantId: Number(cfg.merchantId),
      appId: cfg.appId,
      referenceId: txnId, // NOTE: the TXNID you sent, not REFERENCEID
      txnAmt: amountPaisa,
      token: await rsaSha256SignBase64(cfg.privateKeyPem, tokenString),
    };
    const res = await http<ConnectIpsTxnDetail>("connectips", `${base}/connectipswebws/api/creditor/${path}`, {
      method: "POST",
      headers: auth,
      body,
      timeoutMs,
      retries: 2,
    });
    if (res.status === 401) throw new PaymentError("connectIPS: 401 — wrong APPID/app password", "connectips", "unauthorized", 401);
    if (res.status !== 200 || !res.data?.status) {
      throw new PaymentError(`connectIPS ${path} failed: ${res.text.slice(0, 200)}`, "connectips", `http_${res.status}`, res.status, res.data);
    }
    return res.data;
  }

  const adapter = {
    id: "connectips" as const,

    /**
     * Form POST to the connectIPS login page. TXNID = orderId (<= 20 chars, unique per app).
     * Success/failure redirect URLs are REGISTERED WITH NCHL, not sent per request; returnUrl is unused here.
     */
    async initiate(input: InitiateInput & { referenceId?: string; remarks?: string; particulars?: string }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "connectips");
      if (!/^[A-Za-z0-9-]{1,20}$/.test(input.orderId)) {
        throw new PaymentError("connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", "connectips", "invalid_order_id");
      }
      const f: Record<string, string> = {
        MERCHANTID: String(cfg.merchantId),
        APPID: cfg.appId,
        APPNAME: cfg.appName.slice(0, 30),
        TXNID: input.orderId,
        TXNDATE: connectIpsDate(),
        TXNCRNCY: "NPR",
        TXNAMT: String(input.amountPaisa), // PAISA
        REFERENCEID: clip(input.referenceId ?? input.orderId, 20),
        REMARKS: clip(input.remarks ?? input.description, 50) || "Payment",
        PARTICULARS: clip(input.particulars ?? input.description, 100) || "Payment",
      };
      f.TOKEN = await rsaSha256SignBase64(cfg.privateKeyPem, connectIpsTokenString(f));
      return { kind: "form", action: `${base}/connectipswebgw/loginpage`, method: "POST", fields: f };
    },

    /** validatetxn — authoritative. SUCCESS + amount match = paid. */
    async verify({ orderId, amountPaisa }: VerifyInput): Promise<VerifyResult> {
      const r = await validationCall("validatetxn", orderId, amountPaisa);
      const desc = (r.statusDesc ?? "").toUpperCase();
      let status: PaymentStatus;
      if (r.status === "SUCCESS") status = "paid";
      else if (r.status === "FAILED") status = "failed";
      else if (desc.includes("NOT FOUND")) status = "not_found";
      else if (desc.includes("INCOMPLETE")) status = "pending"; // user hasn't finished OTP yet
      else status = "unknown";
      const amt = r.txnAmt !== undefined ? Math.round(Number(r.txnAmt)) : null;
      return { provider: "connectips", status, orderId, amountPaisa: Number.isFinite(amt) ? amt : null, transactionId: null, raw: r };
    },

    /** Full detail incl. NCHL txnId, bank, charges and creditStatus ("000"/"999"/"DEFER" = credited/OK). */
    getTxnDetail(orderId: string, amountPaisa: number) {
      return validationCall("gettxndetail", orderId, amountPaisa);
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.TXNID || params.txnId || null;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
