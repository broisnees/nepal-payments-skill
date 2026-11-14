import type { PaymentStatus } from "../../core/types.ts";

export const URLS = {
  sandbox: {
    form: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://rc.esewa.com.np/api/epay/transaction/status/",
    intent: "https://rc-checkout.esewa.com.np/api/client/intent/payment",
  },
  production: {
    form: "https://epay.esewa.com.np/api/epay/main/v2/form",
    status: "https://esewa.com.np/api/epay/transaction/status/",
    // eSewa provides the production Intent host at go-live — pass intent.baseUrl
    intent: undefined,
  },
} as const;

/** ePay status API `status` -> PaymentStatus. */
export const EPAY_STATUS: Record<string, PaymentStatus> = {
  COMPLETE: "paid",
  PENDING: "pending",
  AMBIGUOUS: "pending", // "payment is at halt state" — keep re-checking
  FULL_REFUND: "refunded",
  PARTIAL_REFUND: "partially_refunded",
  NOT_FOUND: "not_found", // session expired / never paid / wrong amount
  CANCELED: "canceled",
};

/** Intent status API `status` -> PaymentStatus. */
export const INTENT_STATUS: Record<string, PaymentStatus> = {
  SUCCESS: "paid",
  BOOKED: "pending",
  PENDING: "pending",
  FAILED: "failed",
  CANCELED: "canceled",
  REVERTED: "refunded",
};
