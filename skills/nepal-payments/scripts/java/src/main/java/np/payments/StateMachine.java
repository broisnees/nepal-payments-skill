package np.payments;

import java.util.Collections;
import java.util.EnumSet;
import java.util.Set;

/**
 * Pure state-machine decision for a verify() result (references/architecture.md §2, §4).
 * Apply {@code next} with a conditional UPDATE guarded by {@code prev}, and fulfil only if next == PAID.
 * Refund transitions (paid -> refunded) come from your refund flow, not from here.
 */
public final class StateMachine {
    /** Longest provider session (Khalti pidx ~60 min, eSewa ~50 min). */
    public static final long DEFAULT_SESSION_WINDOW_MS = 60 * 60_000L;

    /** Attempts in these states may still move: initiated, pending, unknown (in that order). */
    public static final Set<AttemptStatus> OPEN_STATUSES =
            Collections.unmodifiableSet(EnumSet.of(AttemptStatus.INITIATED, AttemptStatus.PENDING, AttemptStatus.UNKNOWN));

    private static final Set<AttemptStatus> CLOSED_UNPAID =
            EnumSet.of(AttemptStatus.FAILED, AttemptStatus.CANCELED, AttemptStatus.EXPIRED, AttemptStatus.NOT_FOUND);

    private StateMachine() {}

    public static TransitionDecision decideTransition(
            AttemptStatus prev, VerifyResult result, long storedAmountPaisa, long attemptAgeMs) {
        return decideTransition(prev, result.status(), result.amountPaisa(), storedAmountPaisa, attemptAgeMs,
                DEFAULT_SESSION_WINDOW_MS);
    }

    public static TransitionDecision decideTransition(
            AttemptStatus prev, VerifyResult result, long storedAmountPaisa, long attemptAgeMs, long sessionWindowMs) {
        return decideTransition(prev, result.status(), result.amountPaisa(), storedAmountPaisa, attemptAgeMs,
                sessionWindowMs);
    }

    public static TransitionDecision decideTransition(
            AttemptStatus prev,
            PaymentStatus status,
            Long amountPaisa,
            long storedAmountPaisa,
            long attemptAgeMs,
            long sessionWindowMs) {
        boolean latePaid = status == PaymentStatus.PAID && CLOSED_UNPAID.contains(prev);
        if (!OPEN_STATUSES.contains(prev) && !latePaid) {
            return new TransitionDecision(null, false, false, "attempt already " + prev);
        }
        if (status == PaymentStatus.PAID && (amountPaisa == null || amountPaisa.longValue() != storedAmountPaisa)) {
            return new TransitionDecision(AttemptStatus.UNKNOWN, true, latePaid,
                    amountPaisa == null
                            ? "provider returned no amount for a paid status"
                            : "amount mismatch: stored " + storedAmountPaisa + ", provider " + amountPaisa);
        }
        AttemptStatus next = AttemptStatus.of(status);
        if (next == AttemptStatus.NOT_FOUND) {
            // Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
            if (attemptAgeMs < sessionWindowMs) {
                return new TransitionDecision(null, false, false, "not_found inside session window");
            }
            next = AttemptStatus.EXPIRED;
        }
        if (next == prev) return new TransitionDecision(null, false, false, "unchanged");
        return new TransitionDecision(next, false, latePaid, latePaid ? "late payment (was " + prev + ")" : prev + " -> " + next);
    }
}
