import type { PaymentStatus } from "../../core/types.ts";

export const BASE = {
  sandbox: "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
  production: "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
} as const;

/** The browser SDK (same bundle for both envs unless the bank gives you another). */
export const BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js";

/** Server-side status APIs (POST {base}/<path>). */
export type GetPayApiPath = "merchant-status" | "transaction-statement";

/** Transaction `status`, uppercased -> PaymentStatus. */
export const TXN_STATUS: Record<string, PaymentStatus> = {
  SUCCESS: "paid",
  APPROVED: "paid",
  FAILED: "failed",
  FAILURE: "failed",
  DECLINED: "failed",
  PENDING: "pending",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};
