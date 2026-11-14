import type { PaymentStatus } from "../../core/types.ts";

export const HOST = {
  sandbox: "https://testsecureacceptance.cybersource.com",
  production: "https://secureacceptance.cybersource.com",
} as const;

/** Reason codes for CyberSource-side system errors: re-check, don't retry blindly. */
const SYSTEM_ERROR_REASONS = ["150", "151", "152"];

/**
 * decision ACCEPT -> paid (for "sale"); REVIEW -> pending (Decision Manager / AVS/CVN review;
 * settle manually); DECLINE / ERROR -> failed; CANCEL -> canceled.
 */
export function mapDecision(
  decision: string | undefined,
  reasonCode: string | undefined,
  txnType: string,
): PaymentStatus {
  switch (decision?.toUpperCase()) {
    case "ACCEPT":
      // auth-only isn't captured money yet
      return txnType.startsWith("authorization") ? "pending" : "paid";
    case "REVIEW":
      return "pending";
    case "DECLINE":
    case "ERROR":
      return SYSTEM_ERROR_REASONS.includes(reasonCode ?? "") ? "unknown" : "failed";
    case "CANCEL":
      return "canceled";
    default:
      return "unknown";
  }
}
