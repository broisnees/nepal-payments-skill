import type { PaymentStatus } from "../../core/types.ts";

export const BASE = {
  sandbox: "https://uat.connectips.com",
  production: "https://login.connectips.com",
} as const;

/** Where the browser form is POSTed. */
export const LOGIN_PAGE_PATH = "/connectipswebgw/loginpage";

/** Server-to-server validation APIs (Basic auth). */
export type ValidationPath = "validatetxn" | "gettxndetail";
export const validationUrl = (base: string, path: ValidationPath) =>
  `${base}/connectipswebws/api/creditor/${path}`;

/**
 * validatetxn `status` + `statusDesc` -> PaymentStatus. SUCCESS / FAILED are definitive; for
 * anything else the description tells "not found" from "user still on the OTP page".
 */
export function mapValidationStatus(status: unknown, statusDesc: unknown): PaymentStatus {
  const description = String(statusDesc ?? "").toUpperCase();
  if (status === "SUCCESS") return "paid";
  if (status === "FAILED") return "failed";
  if (description.includes("NOT FOUND")) return "not_found";
  if (description.includes("INCOMPLETE")) return "pending"; // user hasn't finished OTP yet
  return "unknown";
}
