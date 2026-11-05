/**
 * Fonepay — Web payment (redirect) + Dynamic QR.
 * Source: "Technical Specification Document (Fonepay Web Integration) v2.0" + Dynamic QR spec v1.1 (2024).
 * Credentials come from your acquiring bank / Fonepay merchant onboarding.
 *
 * Signatures: HMAC-SHA512(secretKey UTF-8, comma-joined values) as HEX. Compare case-insensitively.
 *   request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
 *   response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
 *   txnVerification  = username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>
 *   QR create        = amount,prn,merchantCode,remarks1,remarks2
 *   QR status        = prn,merchantCode
 */
import {
  basicAuth,
  hmac,
  http,
  lookup,
  paisaToRupees,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  safeEqual,
  toHex,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface FonepayConfig {
  env: "sandbox" | "production";
  /** PID / merchant code (3–20 chars). Public dev sample: "NBQM". */
  merchantCode: string;
  /** HMAC secret from the merchant profile page. Public dev sample: "a7e3512f5032480a83137793cb2021dc". */
  secretKey: string;
  /** Merchant-panel username/password — required for txnVerification (recommended) and Dynamic QR. */
  username?: string;
  password?: string;
  /** Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank). */
  paymentUrl?: string;
  txnVerificationUrl?: string;
  legacyVerifyUrl?: string;
  qrBaseUrl?: string;
  strictSignature?: boolean;
  timeoutMs?: number;
}

const URLS = {
  sandbox: {
    payment: "https://dev-clientapi.fonepay.com/api/merchantRequest",
    legacyVerify: "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
    // Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on onboarding).
    txnVerification: "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
    qrBase: "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
  },
  production: {
    payment: "https://clientapi.fonepay.com/api/merchantRequest",
    legacyVerify: "https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
    txnVerification: "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
    qrBase: "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
  },
} as const;

const TXN_STATUS: Record<string, PaymentStatus> = { success: "paid", pending: "pending", failed: "failed" };
const TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification";
const RESPONSE_DV_FIELDS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"] as const;

export async function fonepayHmac(secret: string, values: (string | number)[]): Promise<string> {
  return toHex(await hmac("SHA-512", secret, values.join(","))).toUpperCase();
}

/** MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats). */
export function fonepayDate(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("month")}/${get("day")}/${get("year")}`;
}

export function fonepay(cfg: FonepayConfig) {
  const u = URLS[cfg.env];
  const urls = {
    payment: cfg.paymentUrl ?? u.payment,
    legacyVerify: cfg.legacyVerifyUrl ?? u.legacyVerify,
    txnVerification: cfg.txnVerificationUrl ?? u.txnVerification,
    qrBase: cfg.qrBaseUrl ?? u.qrBase,
  };
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const strict = cfg.strictSignature ?? true;
  const sign = (values: (string | number)[]) => fonepayHmac(cfg.secretKey, values);

  async function callbackValid(params: Record<string, string>): Promise<boolean> {
    if (!params.DV) return false;
    const expected = await sign(RESPONSE_DV_FIELDS.map((f) => params[f] ?? ""));
    return safeEqual(expected, params.DV.toUpperCase());
  }

  async function txnVerification(prn: string, amountPaisa: number) {
    if (!cfg.username || !cfg.password) throw new Error("fonepay: username/password required for txnVerification");
    // Body is signed byte-for-byte; build it once and send exactly that string (format follows the spec example).
    const body = `{"prn": ${JSON.stringify(prn)},"merchantCode": ${JSON.stringify(cfg.merchantCode)},"amount": ${JSON.stringify(paisaToRupees(amountPaisa))}}`;
    const auth = toHex(
      await hmac("SHA-512", cfg.secretKey, [cfg.username, cfg.password, "POST", "application/json", TXN_RESOURCE, body].join(",")),
    );
    const res = await http<Record<string, any>>("fonepay", urls.txnVerification, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg.username, cfg.password), auth, "Content-Type": "application/json" },
      body,
      timeoutMs,
      retries: 2,
    });
    if (res.status !== 200 || typeof res.data?.paymentStatus !== "string") {
      throw new PaymentError(`Fonepay txnVerification failed: ${res.text.slice(0, 200)}`, "fonepay", `http_${res.status}`, res.status, res.data);
    }
    return res.data as { paymentStatus: string; prn: string; requestedAmount: string; totalTransactionAmount: string; fonepayTraceId: number | string };
  }

  /** Legacy (2019) GET verification; needs UID + BC from the redirect. Returns XML. */
  async function legacyVerify(prn: string, amountPaisa: number, uid: string, bankCode: string) {
    const AMT = paisaToRupees(amountPaisa);
    const DV = await sign([cfg.merchantCode, AMT, prn, bankCode, uid]);
    const qs = new URLSearchParams({ PRN: prn, PID: cfg.merchantCode, BID: bankCode, AMT, UID: uid, DV });
    const res = await http("fonepay", `${urls.legacyVerify}?${qs}`, { timeoutMs, retries: 2, headers: { Accept: "application/xml" } });
    // A 5xx / WAF page / HTML must never read as "not paid": throw so the attempt stays open.
    if (res.status !== 200) {
      throw new PaymentError(`Fonepay verification HTTP ${res.status}`, "fonepay", "upstream_error", res.status, res.text.slice(0, 500));
    }
    const tag = (t: string) => res.text.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const code = tag("response_code");
    if (code === undefined) {
      throw new PaymentError("Fonepay verification: unparseable response", "fonepay", "malformed_response", res.status, res.text.slice(0, 500));
    }
    return { ok: code === "successful" && tag("success") === "true", text: res.text, status: res.status };
  }

  const adapter = {
    id: "fonepay" as const,

    /**
     * Redirect URL for the Fonepay web payment page.
     * PRN = orderId (3–25 chars). Keep `returnUrl` (RU) <= 150 chars and free of query strings.
     */
    async initiate(input: InitiateInput & { remarks2?: string }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "fonepay");
      if (input.orderId.length < 3 || input.orderId.length > 25) {
        throw new PaymentError("Fonepay PRN must be 3–25 chars", "fonepay", "invalid_order_id");
      }
      if (input.returnUrl.length > 150) throw new PaymentError("Fonepay RU must be <= 150 chars", "fonepay", "invalid_return_url");
      const p: Record<string, string> = {
        PID: cfg.merchantCode,
        MD: "P",
        PRN: input.orderId,
        AMT: paisaToRupees(input.amountPaisa), // rupees; the SAME string goes into DV
        CRN: "NPR",
        DT: fonepayDate(),
        R1: input.description.slice(0, 160) || "Payment",
        R2: (input.remarks2 ?? "N/A").slice(0, 50) || "N/A",
        RU: input.returnUrl,
      };
      p.DV = await sign([p.PID, p.MD, p.PRN, p.AMT, p.CRN, p.DT, p.R1, p.R2, p.RU]); // raw (not URL-encoded) values
      return { kind: "redirect", url: `${urls.payment}?${new URLSearchParams(p)}` };
    },

    /**
     * Authoritative check. Uses txnVerification when username/password are configured (works without a
     * callback, so the reconciliation job can use it). Otherwise falls back to the legacy GET verification,
     * which needs UID + BC from the redirect params.
     */
    async verify({ orderId, amountPaisa, callback }: VerifyInput): Promise<VerifyResult> {
      // Callback params are trusted ONLY with a valid DV. A missing DV is treated exactly like a bad one,
      // otherwise anyone could send ?PRN=<id>&PS=false without a DV and force a "failed" outcome.
      let trusted: Record<string, string> | undefined;
      if (callback && Object.keys(callback).some((k) => k === "DV" || (RESPONSE_DV_FIELDS as readonly string[]).includes(k))) {
        if (await callbackValid(callback)) {
          if (callback.PRN !== orderId || callback.PID !== cfg.merchantCode) {
            throw new PaymentError("Fonepay: callback does not match this attempt", "fonepay", "callback_mismatch", 400, callback);
          }
          trusted = callback;
        } else if (strict) {
          throw new PaymentError("Fonepay: missing or invalid response DV", "fonepay", "invalid_signature", 400, callback);
        }
      }

      if (cfg.username && cfg.password) {
        const r = await txnVerification(orderId, amountPaisa);
        return {
          provider: "fonepay",
          status: lookup(TXN_STATUS, r.paymentStatus.toLowerCase()) ?? "unknown",
          orderId,
          amountPaisa: r.requestedAmount ? rupeesToPaisa(r.requestedAmount) : null,
          transactionId: r.fonepayTraceId != null ? String(r.fonepayTraceId) : (trusted?.UID ?? null),
          raw: r,
        };
      }

      if (trusted?.UID && trusted?.BC) {
        // Authentic (DV-verified) negative outcome from Fonepay.
        if (trusted.PS !== "true" || trusted.RC !== "successful") {
          const status: PaymentStatus = trusted.RC === "cancel" ? "canceled" : "failed";
          return { provider: "fonepay", status, orderId, amountPaisa: null, transactionId: trusted.UID || null, raw: trusted };
        }
        const r = await legacyVerify(orderId, amountPaisa, trusted.UID, trusted.BC);
        return {
          provider: "fonepay",
          status: r.ok ? "paid" : "failed",
          orderId,
          amountPaisa: trusted.R_AMT ? rupeesToPaisa(trusted.R_AMT) : null, // R_AMT = amount requested by merchant (DV-signed)
          transactionId: trusted.UID,
          raw: { callback: trusted, verification: r.text },
        };
      }

      throw new PaymentError(
        "Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured for txnVerification",
        "fonepay",
        "verify_unavailable",
      );
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.PRN || null;
    },

    callbackValid,

    // ------------------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

    /** Create a dynamic QR. Render `qrMessage` as a QR code; listen on `webSocketUrl` or poll qrStatus(). */
    async qrCreate(input: { orderId: string; amountPaisa: number; remarks1: string; remarks2?: string }) {
      requireLogin();
      assertPaisa(input.amountPaisa, "fonepay");
      const amount = paisaToRupees(input.amountPaisa);
      const remarks2 = input.remarks2 ?? "N/A";
      const body = {
        amount,
        remarks1: input.remarks1,
        remarks2,
        prn: input.orderId,
        merchantCode: cfg.merchantCode,
        dataValidation: (await sign([amount, input.orderId, cfg.merchantCode, input.remarks1, remarks2])).toLowerCase(),
        username: cfg.username,
        password: cfg.password,
      };
      const res = await http<any>("fonepay", `${urls.qrBase}/thirdPartyDynamicQrDownload`, { method: "POST", body, timeoutMs });
      if (!res.data?.qrMessage) {
        throw new PaymentError(`Fonepay QR create failed: ${res.data?.message ?? res.text.slice(0, 200)}`, "fonepay", `http_${res.status}`, res.status, res.data);
      }
      let ws: string | undefined = res.data.thirdpartyQrWebSocketUrl;
      // Fonepay has been seen returning a localhost host here; rewrite to the real socket host.
      if (ws?.includes("localhost")) ws = ws.replace(/^wss?:\/\/[^/]+/, cfg.env === "production" ? "wss://ws.fonepay.com" : "wss://dev-ws.fonepay.com");
      return { qrMessage: res.data.qrMessage as string, webSocketUrl: ws, raw: res.data };
    },

    /**
     * Poll QR payment status. Always call this after a websocket "paymentSuccess" message before fulfilling.
     * Pass the stored amount: the status response has none, but the QR was created server-side with it.
     */
    async qrStatus(orderId: string, amountPaisa?: number): Promise<VerifyResult> {
      requireLogin();
      const body = {
        prn: orderId,
        merchantCode: cfg.merchantCode,
        dataValidation: (await sign([orderId, cfg.merchantCode])).toLowerCase(),
        username: cfg.username,
        password: cfg.password,
      };
      const res = await http<any>("fonepay", `${urls.qrBase}/thirdPartyDynamicQrGetStatus`, { method: "POST", body, timeoutMs, retries: 2 });
      if (typeof res.data?.paymentStatus !== "string") {
        throw new PaymentError(`Fonepay QR status failed: ${res.text.slice(0, 200)}`, "fonepay", `http_${res.status}`, res.status, res.data);
      }
      return {
        provider: "fonepay",
        status: lookup(TXN_STATUS, res.data.paymentStatus.toLowerCase()) ?? "unknown",
        orderId,
        amountPaisa: amountPaisa ?? null,
        transactionId: res.data.fonepayTraceId != null ? String(res.data.fonepayTraceId) : null,
        raw: res.data,
      };
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  function requireLogin() {
    if (!cfg.username || !cfg.password) throw new Error("fonepay: username/password required for Dynamic QR");
  }

  return adapter;
}
