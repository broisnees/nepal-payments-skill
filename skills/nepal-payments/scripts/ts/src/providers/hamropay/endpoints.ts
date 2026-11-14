import type { PaymentStatus } from "../../core/types.ts";

export const API = {
  sandbox: "https://uat-payclient.hamropatro.com",
  production: "https://payclient.hamropatro.com",
} as const;

/** Only the UAT gateway is public; Hamro Pay issues the live one (config.gatewayUrl). */
export const SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout";

export const CREATE_SESSION_PATH = "/v1/checkout/sessionId";
export const GET_TRANSACTION_PATH = "/v1/checkout/transaction";

/** Hamro Pay's `code` for a rejected Client-Id / API key / signature. */
export const UNAUTHORIZED_CODE = 16;

/** Get Transaction `status`, uppercased -> PaymentStatus. */
export const TXN_STATUS: Record<string, PaymentStatus> = {
  COMPLETED: "paid",
  FAILED: "failed",
  PENDING: "pending",
  PROCESSING: "pending",
  NOT_INITIATED: "not_found",
  CANCELED: "canceled",
  CANCELLED: "canceled",
};
