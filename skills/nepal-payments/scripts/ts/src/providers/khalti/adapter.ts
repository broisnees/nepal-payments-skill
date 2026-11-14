/**
 * Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/
 *
 * Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
 *       -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".
 */
import { PaymentError } from "../../core/errors.ts";
import { http } from "../../core/http.ts";
import { assertPaisa } from "../../core/money.ts";
import { lookup, stringOrNull } from "../../core/records.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { KhaltiConfig } from "./config.ts";
import { HOST, initiatePath, lookupPath, refundPath, STATUS } from "./endpoints.ts";
import { isInitiateResponse, isLookupResponse, isNotFound, khaltiError } from "./responses.ts";

export interface KhaltiInitiateExtras {
  /** Must sum to amountPaisa or Khalti returns "Amount Breakdown mismatch". */
  amountBreakdown?: { label: string; amount: number }[];
  productDetails?: {
    identity: string;
    name: string;
    total_price: number;
    quantity: number;
    unit_price: number;
  }[];
  /** Keys must start with "merchant_"; echoed back in the success payload. */
  merchantExtras?: Record<`merchant_${string}`, string>;
}

export interface KhaltiRefundOptions {
  amountPaisa?: number;
  mobile?: string;
}

const KHALTI_MIN_PAISA = 1000;

function initiateBody(input: InitiateInput & KhaltiInitiateExtras, websiteUrl: string) {
  return {
    return_url: input.returnUrl,
    website_url: websiteUrl,
    amount: input.amountPaisa, // integer paisa
    purchase_order_id: input.orderId,
    purchase_order_name: input.description.slice(0, 255),
    ...(input.customer && { customer_info: input.customer }),
    ...(input.amountBreakdown && { amount_breakdown: input.amountBreakdown }),
    ...(input.productDetails && { product_details: input.productDetails }),
    ...input.merchantExtras,
  };
}

export function khalti(cfg: KhaltiConfig) {
  if (!cfg.secretKey) throw new Error("khalti: secretKey is required");
  const host = HOST[cfg.env];
  const auth = { Authorization: `Key ${cfg.secretKey.replace(/^key\s+/i, "")}` };
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  const notFound = (orderId: string, raw: unknown): VerifyResult => ({
    provider: "khalti",
    status: "not_found",
    orderId,
    amountPaisa: null,
    transactionId: null,
    raw,
  });

  const adapter = {
    id: "khalti" as const,

    async initiate(input: InitiateInput & KhaltiInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "khalti");
      if (input.amountPaisa < KHALTI_MIN_PAISA) {
        throw new PaymentError("Khalti minimum is Rs 10 (1000 paisa)", "khalti", "amount_too_low");
      }
      const res = await http("khalti", `${host}${initiatePath}`, {
        method: "POST",
        headers: auth,
        body: initiateBody(input, cfg.websiteUrl),
        timeoutMs,
        // no retries: initiate is not idempotent
      });
      if (res.status !== 200 || !isInitiateResponse(res.data)) throw khaltiError(res);
      return {
        kind: "redirect",
        url: res.data.payment_url,
        // PERSIST THIS — lookup needs it and there is no lookup-by-order-id
        providerRef: res.data.pidx,
        expiresAt: res.data.expires_at,
        raw: res.data,
      };
    },

    async verify({ orderId, providerRef, callback }: VerifyInput): Promise<VerifyResult> {
      // Use the pidx stored at initiate time. The lookup response does not include
      // purchase_order_id, so trusting a pidx from the callback would let a payer replay another
      // payment's pidx.
      const pidx = providerRef;
      if (!pidx) {
        throw new PaymentError("khalti: stored pidx required for verify", "khalti", "missing_pidx");
      }
      if (callback?.pidx && callback.pidx !== pidx) {
        throw new PaymentError(
          "khalti: callback pidx does not match stored pidx",
          "khalti",
          "pidx_mismatch",
          400,
          callback,
        );
      }

      const res = await http("khalti", `${host}${lookupPath}`, {
        method: "POST",
        headers: auth,
        body: { pidx },
        timeoutMs,
        retries: 2, // lookup is a read; safe to retry
      });

      // Expired / User canceled come back as HTTP 400 WITH a normal body — parse, don't throw.
      if (isLookupResponse(res.data)) {
        const body = res.data;
        return {
          provider: "khalti",
          status: lookup(STATUS, body.status.toLowerCase()) ?? "unknown",
          orderId,
          amountPaisa: typeof body.total_amount === "number" ? body.total_amount : null,
          transactionId: stringOrNull(body.transaction_id),
          raw: body,
        };
      }
      if (isNotFound(res)) return notFound(orderId, res.data);
      throw khaltiError(res);
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.purchase_order_id || null;
    },

    /**
     * Refund a completed transaction (transaction_id from lookup). Full refund when amountPaisa
     * is omitted. `mobile` is required for payments made via bank/e-banking.
     * Note: Khalti's docs say partial refund `amount` is paisa but their example shows "50.00";
     * confirm the unit in sandbox before relying on partial refunds.
     */
    async refund(transactionId: string, opts: KhaltiRefundOptions = {}): Promise<unknown> {
      const body: Record<string, unknown> = {};
      if (opts.amountPaisa !== undefined) {
        assertPaisa(opts.amountPaisa, "khalti");
        body.amount = opts.amountPaisa;
      }
      if (opts.mobile) body.mobile = opts.mobile;
      const res = await http("khalti", `${host}${refundPath(transactionId)}`, {
        method: "POST",
        headers: auth,
        body,
        timeoutMs,
      });
      if (res.status !== 200) throw khaltiError(res);
      return res.data;
    },
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}
