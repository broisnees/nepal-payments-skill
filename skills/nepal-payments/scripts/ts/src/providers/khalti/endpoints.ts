import type { PaymentStatus } from "../../core/types.ts";

export const HOST = {
  sandbox: "https://dev.khalti.com",
  production: "https://khalti.com",
} as const;

// Trailing slashes are REQUIRED on every endpoint: without one Khalti 301s and the POST body is
// lost.
export const initiatePath = "/api/v2/epayment/initiate/";
export const lookupPath = "/api/v2/epayment/lookup/";
export const refundPath = (transactionId: string) =>
  `/api/merchant-transaction/${encodeURIComponent(transactionId)}/refund/`;

/** Lookup `status`, lowercased -> PaymentStatus. */
export const STATUS: Record<string, PaymentStatus> = {
  completed: "paid",
  pending: "pending",
  initiated: "pending", // user hasn't paid yet; Khalti flips it to Expired after the link expires
  refunded: "refunded",
  "partially refunded": "partially_refunded",
  expired: "expired",
  "user canceled": "canceled",
  failed: "failed",
};
