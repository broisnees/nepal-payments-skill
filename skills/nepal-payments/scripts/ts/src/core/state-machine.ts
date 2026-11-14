/**
 * The payment-attempt state machine (references/architecture.md §2, §4).
 */
import type { PaymentStatus, VerifyResult } from "./types.ts";

/**
 * Status as stored on a payment attempt row
 * ("initiated" = created, provider not yet heard from).
 */
export type AttemptStatus = PaymentStatus | "initiated";
export const OPEN_STATUSES: readonly AttemptStatus[] = ["initiated", "pending", "unknown"];
const CLOSED_UNPAID: readonly AttemptStatus[] = ["failed", "canceled", "expired", "not_found"];

export interface TransitionDecision {
  /** Status to write, or null to write nothing. */
  next: AttemptStatus | null;
  /** Stop automation and alert a human (amount mismatch / provider gave no amount for a "paid"). */
  reviewRequired: boolean;
  /** Provider says paid after we had closed the attempt: recover + alert. */
  latePaid: boolean;
  reason: string;
}

const writeNothing = (reason: string): TransitionDecision => ({
  next: null,
  reviewRequired: false,
  latePaid: false,
  reason,
});

function amountProblem(providerAmount: number | null, storedAmountPaisa: number): string {
  if (providerAmount === null) return "provider returned no amount for a paid status";
  return `amount mismatch: stored ${storedAmountPaisa}, provider ${providerAmount}`;
}

/**
 * Pure state-machine decision for a verify() result (references/architecture.md §2, §4).
 * Apply `next` with a conditional UPDATE guarded by `prev`, and fulfil only if next === "paid".
 * Refund transitions (paid -> refunded) come from your refund flow, not from here.
 */
export function decideTransition(
  prev: AttemptStatus,
  result: Pick<VerifyResult, "status" | "amountPaisa">,
  storedAmountPaisa: number,
  attemptAgeMs: number,
  sessionWindowMs = 60 * 60_000,
): TransitionDecision {
  const latePaid = result.status === "paid" && CLOSED_UNPAID.includes(prev);
  if (!OPEN_STATUSES.includes(prev) && !latePaid) return writeNothing(`attempt already ${prev}`);

  if (result.status === "paid" && result.amountPaisa !== storedAmountPaisa) {
    return {
      next: "unknown",
      reviewRequired: true,
      latePaid,
      reason: amountProblem(result.amountPaisa, storedAmountPaisa),
    };
  }

  let next: AttemptStatus = result.status;
  if (next === "not_found") {
    // Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
    if (attemptAgeMs < sessionWindowMs) return writeNothing("not_found inside session window");
    next = "expired";
  }
  if (next === prev) return writeNothing("unchanged");

  const reason = latePaid ? `late payment (was ${prev})` : `${prev} -> ${next}`;
  return { next, reviewRequired: false, latePaid, reason };
}
