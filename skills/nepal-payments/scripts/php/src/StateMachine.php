<?php

declare(strict_types=1);

namespace NepalPayments;

/** Pure state-machine decision for a verify() result (references/architecture.md §2, §4). */
final class StateMachine
{
    public const OPEN_STATUSES = [AttemptStatus::Initiated, AttemptStatus::Pending, AttemptStatus::Unknown];
    public const DEFAULT_SESSION_WINDOW_MS = 3_600_000;
    private const CLOSED_UNPAID = [AttemptStatus::Failed, AttemptStatus::Canceled, AttemptStatus::Expired, AttemptStatus::NotFound];

    private function __construct()
    {
    }

    /**
     * Same as {@see decideTransition()} but takes the verify() result directly (TS passes `result`).
     */
    public static function decideFor(
        AttemptStatus $prev,
        VerifyResult $result,
        int $storedAmountPaisa,
        int $attemptAgeMs,
        int $sessionWindowMs = self::DEFAULT_SESSION_WINDOW_MS,
    ): TransitionDecision {
        return self::decideTransition($prev, $result->status, $result->amountPaisa, $storedAmountPaisa, $attemptAgeMs, $sessionWindowMs);
    }

    /**
     * Apply `next` with a conditional UPDATE guarded by `$prev`, and fulfil only if next === AttemptStatus::Paid.
     * Refund transitions (paid -> refunded) come from your refund flow, not from here.
     *
     * @param int|null $providerAmountPaisa VerifyResult::$amountPaisa
     */
    public static function decideTransition(
        AttemptStatus $prev,
        PaymentStatus $status,
        ?int $providerAmountPaisa,
        int $storedAmountPaisa,
        int $attemptAgeMs,
        int $sessionWindowMs = self::DEFAULT_SESSION_WINDOW_MS,
    ): TransitionDecision {
        $latePaid = $status === PaymentStatus::Paid && in_array($prev, self::CLOSED_UNPAID, true);
        if (!in_array($prev, self::OPEN_STATUSES, true) && !$latePaid) {
            return new TransitionDecision(null, false, false, "attempt already {$prev->value}");
        }
        if ($status === PaymentStatus::Paid && $providerAmountPaisa !== $storedAmountPaisa) {
            return new TransitionDecision(
                AttemptStatus::Unknown,
                true,
                $latePaid,
                $providerAmountPaisa === null
                    ? 'provider returned no amount for a paid status'
                    : "amount mismatch: stored {$storedAmountPaisa}, provider {$providerAmountPaisa}",
            );
        }
        $next = AttemptStatus::fromPaymentStatus($status);
        if ($next === AttemptStatus::NotFound) {
            // Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
            if ($attemptAgeMs < $sessionWindowMs) {
                return new TransitionDecision(null, false, false, 'not_found inside session window');
            }
            $next = AttemptStatus::Expired;
        }
        if ($next === $prev) {
            return new TransitionDecision(null, false, false, 'unchanged');
        }

        return new TransitionDecision($next, false, $latePaid, $latePaid ? "late payment (was {$prev->value})" : "{$prev->value} -> {$next->value}");
    }
}
