<?php

declare(strict_types=1);

namespace NepalPayments;

/** Status as stored on a payment attempt row: every PaymentStatus plus "initiated" (created, provider not yet heard from). */
enum AttemptStatus: string
{
    case Initiated = 'initiated';
    case Paid = 'paid';
    case Pending = 'pending';
    case Failed = 'failed';
    case Canceled = 'canceled';
    case Expired = 'expired';
    case Refunded = 'refunded';
    case PartiallyRefunded = 'partially_refunded';
    case NotFound = 'not_found';
    case Unknown = 'unknown';

    public static function fromPaymentStatus(PaymentStatus $status): self
    {
        return self::from($status->value);
    }

    public function isOpen(): bool
    {
        return in_array($this, StateMachine::OPEN_STATUSES, true);
    }
}
