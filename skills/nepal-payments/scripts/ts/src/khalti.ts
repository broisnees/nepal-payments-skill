/**
 * Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/
 *
 * Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
 *       -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".
 */
import {
  http,
  lookup,
  PaymentError,
  assertPaisa,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface KhaltiConfig {
  /** "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com (production). */
  secretKey: string;
  env: "sandbox" | "production";
  /** Your site's public URL (required by Khalti). */
  websiteUrl: string;
  timeoutMs?: number;
}

export interface KhaltiInitiateExtras {
  /** Must sum to amountPaisa or Khalti returns "Amount Breakdown mismatch". */
  amountBreakdown?: { label: string; amount: number }[];
  productDetails?: { identity: string; name: string; total_price: number; quantity: number; unit_price: number }[];
  /** Keys must start with "merchant_"; echoed back in the success payload. */
  merchantExtras?: Record<`merchant_${string}`, string>;
}

const HOST = { sandbox: "https://dev.khalti.com", production: "https://khalti.com" } as const;

const STATUS: Record<string, PaymentStatus> = {
  completed: "paid",
  pending: "pending",
  initiated: "pending", // user hasn't paid yet; Khalti flips it to Expired after the link expires
  refunded: "refunded",
  "partially refunded": "partially_refunded",
  expired: "expired",
  "user canceled": "canceled",
  failed: "failed",
};

interface InitiateResponse {
  pidx: string;
  payment_url: string;
  expires_at: string;
  expires_in: number;
}

interface LookupResponse {
  pidx: string;
  total_amount: number;
  status: string;
  transaction_id: string | null;
  fee: number;
  refunded: boolean;
}

export function khalti(cfg: KhaltiConfig) {
  if (!cfg.secretKey) throw new Error("khalti: secretKey is required");
  const base = `${HOST[cfg.env]}/api/v2`;
  const auth = { Authorization: `Key ${cfg.secretKey.replace(/^key\s+/i, "")}` };
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  const adapter = {
    id: "khalti" as const,

    async initiate(input: InitiateInput & KhaltiInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "khalti");
      if (input.amountPaisa < 1000) {
        throw new PaymentError("Khalti minimum is Rs 10 (1000 paisa)", "khalti", "amount_too_low");
      }
      const body: Record<string, unknown> = {
        return_url: input.returnUrl,
        website_url: cfg.websiteUrl,
        amount: input.amountPaisa, // integer paisa
        purchase_order_id: input.orderId,
        purchase_order_name: input.description.slice(0, 255),
        ...(input.customer && { customer_info: input.customer }),
        ...(input.amountBreakdown && { amount_breakdown: input.amountBreakdown }),
        ...(input.productDetails && { product_details: input.productDetails }),
        ...input.merchantExtras,
      };
      // Trailing slash is REQUIRED: without it Khalti 301s and the POST body is lost.
      const res = await http<InitiateResponse & Record<string, unknown>>("khalti", `${base}/epayment/initiate/`, {
        method: "POST",
        headers: auth,
        body,
        timeoutMs,
        // no retries: initiate is not idempotent
      });
      if (res.status !== 200 || !res.data?.pidx) {
        throw new PaymentError(khaltiErrorMessage(res.data), "khalti", errorKey(res.data, res.status), res.status, res.data);
      }
      return {
        kind: "redirect",
        url: res.data.payment_url,
        providerRef: res.data.pidx, // PERSIST THIS — lookup needs it and there is no lookup-by-order-id
        expiresAt: res.data.expires_at,
        raw: res.data,
      };
    },

    async verify({ orderId, providerRef, callback }: VerifyInput): Promise<VerifyResult> {
      // Use the pidx stored at initiate time. The lookup response does not include purchase_order_id,
      // so trusting a pidx from the callback would let a payer replay another payment's pidx.
      const pidx = providerRef;
      if (!pidx) throw new PaymentError("khalti: stored pidx required for verify", "khalti", "missing_pidx");
      if (callback?.pidx && callback.pidx !== pidx) {
        throw new PaymentError("khalti: callback pidx does not match stored pidx", "khalti", "pidx_mismatch", 400, callback);
      }

      const res = await http<LookupResponse & Record<string, unknown>>("khalti", `${base}/epayment/lookup/`, {
        method: "POST",
        headers: auth,
        body: { pidx },
        timeoutMs,
        retries: 2, // lookup is a read; safe to retry
      });

      // Expired / User canceled come back as HTTP 400 WITH a normal body — parse, don't throw.
      if (res.data && typeof res.data === "object" && typeof res.data.status === "string") {
        const status = lookup(STATUS, res.data.status.toLowerCase()) ?? "unknown";
        return {
          provider: "khalti",
          status,
          orderId,
          amountPaisa: typeof res.data.total_amount === "number" ? res.data.total_amount : null,
          transactionId: res.data.transaction_id ?? null,
          raw: res.data,
        };
      }
      if (res.status === 404 || (res.data as any)?.detail === "Not found.") {
        return { provider: "khalti", status: "not_found", orderId, amountPaisa: null, transactionId: null, raw: res.data };
      }
      throw new PaymentError(khaltiErrorMessage(res.data), "khalti", errorKey(res.data, res.status), res.status, res.data);
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.purchase_order_id || null;
    },

    /**
     * Refund a completed transaction (transaction_id from lookup). Full refund when amountPaisa is omitted.
     * `mobile` is required for payments made via bank/e-banking.
     * Note: Khalti's docs say partial refund `amount` is paisa but their example shows "50.00";
     * confirm the unit in sandbox before relying on partial refunds.
     */
    async refund(transactionId: string, opts: { amountPaisa?: number; mobile?: string } = {}): Promise<unknown> {
      const body: Record<string, unknown> = {};
      if (opts.amountPaisa !== undefined) {
        assertPaisa(opts.amountPaisa, "khalti");
        body.amount = opts.amountPaisa;
      }
      if (opts.mobile) body.mobile = opts.mobile;
      const res = await http("khalti", `${HOST[cfg.env]}/api/merchant-transaction/${encodeURIComponent(transactionId)}/refund/`, {
        method: "POST",
        headers: auth,
        body,
        timeoutMs,
      });
      if (res.status !== 200) {
        throw new PaymentError(khaltiErrorMessage(res.data), "khalti", errorKey(res.data, res.status), res.status, res.data);
      }
      return res.data;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}

function errorKey(data: any, status: number): string {
  if (status === 401) return "unauthorized";
  return (data && typeof data === "object" && data.error_key) || `http_${status}`;
}

function khaltiErrorMessage(data: any): string {
  if (!data || typeof data !== "object") return `Khalti error: ${String(data).slice(0, 200)}`;
  if (data.detail) return `Khalti: ${data.detail}`;
  const fields = Object.entries(data)
    .filter(([k]) => k !== "error_key" && k !== "status_code")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : String(v)}`);
  return `Khalti: ${fields.join("; ") || "unknown error"}`;
}
