/**
 * GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure) — https://getpay.global/web-integration/
 * Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid, tid}), oprKey, insKey (blank when
 * operator-hosted), the bundle URL and the base URL.
 *
 * Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
 *   -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
 *   -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
 *   -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.
 *
 * merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
 * only counts when the token's oprSecret matches YOUR oprKey and data.clientId is YOUR orderId.
 */
import {
  escapeHtml,
  fromBase64,
  http,
  lookup,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  safeEqual,
  sha256,
  toBase64,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface GetPayConfig {
  env: "sandbox" | "production";
  /** Base64 {"institutionId","mid","tid"} from the bank. */
  papInfo: string;
  /** Operator key from the bank. It also reaches the browser (GetPay's design); it is not a secret. */
  oprKey: string;
  insKey?: string;
  /** Your site origin, e.g. "https://shop.example". GetPay requires the callback URLs on this host. */
  websiteDomain: string;
  businessName: string;
  /** Logo shown on the checkout page (absolute URL). */
  imageUrl: string;
  currency?: string;
  themeColor?: string;
  bundleUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BASE = {
  sandbox: "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
  production: "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
} as const;
const BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js";

const TXN_STATUS: Record<string, PaymentStatus> = {
  SUCCESS: "paid",
  APPROVED: "paid",
  FAILED: "failed",
  FAILURE: "failed",
  DECLINED: "failed",
  PENDING: "pending",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};

/** base64(SHA-256(oprKey + transactionId)): the oprSecret GetPay puts in the return token. */
export async function getPayOprSecret(oprKey: string, transactionId: string): Promise<string> {
  return toBase64(await sha256(oprKey + transactionId));
}

/** Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret". */
export function getPayDecodeToken(token: string): { id: string; oprSecret: string } | null {
  let text: string;
  try {
    text = new TextDecoder().decode(fromBase64(token.trim().replace(/ /g, "+")));
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(text);
    if (j && typeof j.id === "string" && typeof j.oprSecret === "string" && j.id && j.oprSecret) return { id: j.id, oprSecret: j.oprSecret };
    return null;
  } catch {
    const i = text.indexOf(":");
    return i > 0 && i < text.length - 1 ? { id: text.slice(0, i), oprSecret: text.slice(i + 1) } : null;
  }
}

export function getpay(cfg: GetPayConfig) {
  const base = (cfg.baseUrl ?? BASE[cfg.env]).replace(/\/$/, "");
  const bundleUrl = cfg.bundleUrl ?? BUNDLE;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const origin = new URL(cfg.websiteDomain).origin;

  async function call(path: "merchant-status" | "transaction-statement", body: Record<string, string>) {
    const res = await http<{ status?: number; message?: string; data?: Record<string, unknown> }>("getpay", `${base}/${path}`, {
      method: "POST",
      body,
      timeoutMs,
      retries: 2,
    });
    const d = res.data;
    if (d && typeof d === "object" && d.status === -1 && /not found/i.test(String(d.message))) return null;
    if (res.status !== 200 || !d || d.status !== 0 || !d.data || typeof d.data !== "object") {
      throw new PaymentError(`GetPay ${path} failed: ${d?.message ?? res.text.slice(0, 200)}`, "getpay", `http_${res.status}`, res.status, d);
    }
    return d.data;
  }

  const adapter = {
    id: "getpay" as const,

    /**
     * Options for the browser SDK. clientRequestId = orderId. returnUrl / failureUrl must be on websiteDomain and must
     * serve returnPage() (the token can arrive in the #hash, which only the browser sees).
     */
    async initiate(
      input: InitiateInput & { orderInformationUI?: string; allowBillingAddressFields?: boolean },
    ): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "getpay");
      if (!/^[A-Za-z0-9-]{1,50}$/.test(input.orderId)) {
        throw new PaymentError("GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]", "getpay", "invalid_order_id");
      }
      const failUrl = input.failureUrl ?? input.returnUrl;
      for (const u of [input.returnUrl, failUrl]) {
        if (new URL(u).origin !== origin) {
          throw new PaymentError(`GetPay callback ${u} must be on websiteDomain ${origin}`, "getpay", "invalid_callback_url");
        }
      }
      const c = input.customer ?? {};
      return {
        kind: "sdk",
        scriptUrl: bundleUrl,
        options: {
          clientRequestId: input.orderId,
          papInfo: cfg.papInfo,
          oprKey: cfg.oprKey,
          insKey: cfg.insKey ?? "",
          websiteDomain: origin,
          baseUrl: base,
          price: input.amountPaisa / 100, // GetPay wants a number, not a string
          currency: cfg.currency ?? "NPR",
          businessName: cfg.businessName,
          imageUrl: cfg.imageUrl,
          themeColor: cfg.themeColor ?? "#5662FF",
          allowBillingAddressFields: input.allowBillingAddressFields ?? true,
          userInfo: { name: c.name ?? "", email: c.email ?? "", state: "", country: "", zipcode: "", city: "", address: "" },
          prefill: { name: !!c.name, email: !!c.email, state: false, city: false, address: false, zipcode: false, country: false },
          disableFields: {},
          callbackUrl: { successUrl: input.returnUrl, failUrl },
          orderInformationUI: input.orderInformationUI ?? `<div style="font-family:sans-serif"><h3>${escapeHtml(input.description)}</h3><p>${escapeHtml(cfg.currency ?? "NPR")} ${(input.amountPaisa / 100).toFixed(2)}</p></div>`,
        },
      };
    },

    /**
     * With callback.token: check oprSecret against oprKey, then merchant-status, then the transaction must carry your
     * orderId. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot prove the
     * transaction is yours, so a success there comes back "unknown" for manual review.
     */
    async verify({ orderId, callback }: VerifyInput): Promise<VerifyResult> {
      const token = callback?.token;
      if (!token) {
        const s = await call("transaction-statement", { clientRequestId: orderId });
        if (!s) return { provider: "getpay", status: "not_found", orderId, amountPaisa: null, transactionId: null, raw: null };
        const st = lookup(TXN_STATUS, String(s.status ?? "").toUpperCase()) ?? "unknown";
        return {
          provider: "getpay",
          status: st === "paid" ? "unknown" : st,
          orderId,
          amountPaisa: s.saleTransactionAmount != null ? rupeesToPaisa(s.saleTransactionAmount as number) : null,
          transactionId: typeof s.transactionId === "string" ? s.transactionId : null,
          raw: s,
        };
      }
      const t = getPayDecodeToken(token);
      if (!t) throw new PaymentError("GetPay: return token is not base64 {id, oprSecret}", "getpay", "malformed_callback", 400);
      if (!safeEqual(await getPayOprSecret(cfg.oprKey, t.id), t.oprSecret)) {
        throw new PaymentError("GetPay: oprSecret does not match oprKey + id", "getpay", "bad_signature", 400, { id: t.id });
      }
      const d = await adapter.status(t.id);
      if (!d) return { provider: "getpay", status: "not_found", orderId, amountPaisa: null, transactionId: t.id, raw: null };
      if (String(d.clientId ?? "") !== orderId) {
        throw new PaymentError("GetPay: transaction belongs to a different clientRequestId", "getpay", "id_mismatch", 400, d);
      }
      return {
        provider: "getpay",
        status: lookup(TXN_STATUS, String(d.status ?? "").toUpperCase()) ?? "unknown",
        orderId,
        amountPaisa: d.amount != null ? rupeesToPaisa(d.amount as number) : null,
        transactionId: t.id,
        raw: d,
      };
    },

    /** merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks}; null if unknown. */
    status(transactionId: string) {
      return call("merchant-status", { id: transactionId, papInfo: cfg.papInfo });
    },

    /** transaction-statement: payer, masked PAN, scheme, stan, crrn. Query by transactionId or clientRequestId. */
    statement(q: { transactionId: string } | { clientRequestId: string }) {
      return call("transaction-statement", q as Record<string, string>);
    },

    /** The orderId is in YOUR return URL path (GetPay adds only the token); extract it from the route instead. */
    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.clientRequestId || params.orderId || null;
    },

    /** Page 1: loads the bundle and starts checkout; onSuccess opens `paymentPageUrl`. */
    checkoutPage(r: Extract<InitiateResult, { kind: "sdk" }>, paymentPageUrl: string): string {
      const opts = JSON.stringify(r.options).replace(/</g, "\\u003c");
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title>
<script defer src="${escapeHtml(r.scriptUrl)}"></script></head><body><div id="checkout" hidden></div><noscript>JavaScript is required to pay by card.</noscript>
<script>window.addEventListener("load",function(){var o=${opts};o.onSuccess=function(){location.href=${JSON.stringify(paymentPageUrl).replace(/</g, "\\u003c")}};o.onError=function(e){document.body.insertAdjacentHTML("beforeend","<p>Card checkout could not start. Please try again.</p>");console.error(e)};new GetPay(o).initialize()});</script></body></html>`;
    },

    /** Page 2: GetPay renders the card form into #checkout. */
    paymentPage(): string {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay by card</title>
<script defer src="${escapeHtml(bundleUrl)}"></script></head><body><div id="checkout"></div></body></html>`;
    },

    /**
     * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the query or the
     * #hash, and send it to `verifyUrl` as ?token=. Your server then calls verify() with callback.token.
     */
    returnPage(verifyUrl: string): string {
      return `<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title></head><body><p>Confirming your payment...</p>
<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{var h=location.hash||"",q=new URLSearchParams(location.search);var t=q.get("token")||new URLSearchParams(h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");var u=new URL(${JSON.stringify(verifyUrl).replace(/</g, "\\u003c")},location.href);if(t)u.searchParams.set("token",t);location.replace(u.toString())}</script></body></html>`;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
