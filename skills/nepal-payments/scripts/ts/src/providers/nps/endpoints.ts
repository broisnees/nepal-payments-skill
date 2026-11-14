import type { PaymentStatus } from "../../core/types.ts";

export const URLS = {
  sandbox: {
    api: "https://apisandbox.nepalpayment.com",
    gateway: "https://gatewaysandbox.nepalpayment.com/Payment/Index",
  },
  production: {
    api: "https://apigateway.nepalpayment.com",
    gateway: "https://gateway.nepalpayment.com/Payment/Index",
  },
} as const;

/** API operations (POST {api}/<name>). */
export type NpsOperation =
  | "GetPaymentInstrumentDetails"
  | "GetServiceCharge"
  | "GetProcessId"
  | "CheckTransactionStatus";

/** CheckTransactionStatus `data.Status`, lowercased -> PaymentStatus. */
export const STATUS: Record<string, PaymentStatus> = {
  success: "paid",
  fail: "failed",
  failed: "failed",
  pending: "pending",
};

/** error_code "3" = "Transaction not initialized yet" (payer never reached the gateway). */
export const NOT_INITIALIZED_ERROR_CODE = "3";
