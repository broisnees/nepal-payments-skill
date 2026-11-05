<?php

declare(strict_types=1);

namespace NepalPayments;

final class TransitionDecision implements \JsonSerializable
{
    /**
     * @param AttemptStatus|null $next Status to write, or null to write nothing.
     * @param bool $reviewRequired Stop automation and alert a human (amount mismatch / no amount for a "paid").
     * @param bool $latePaid Provider says paid after we had closed the attempt: recover + alert.
     */
    public function __construct(
        public readonly ?AttemptStatus $next,
        public readonly bool $reviewRequired,
        public readonly bool $latePaid,
        public readonly string $reason,
    ) {
    }

    /** @return array{next: string|null, reviewRequired: bool, latePaid: bool, reason: string} */
    public function jsonSerialize(): array
    {
        return ['next' => $this->next?->value, 'reviewRequired' => $this->reviewRequired, 'latePaid' => $this->latePaid, 'reason' => $this->reason];
    }
}
