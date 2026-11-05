<?php

declare(strict_types=1);

namespace NepalPayments;

/** Normalized payment state. Every provider status maps onto exactly one of these. */
enum PaymentStatus: string
{
    /** Money captured; safe to fulfil. */
    case Paid = 'paid';
    /** Provider has not settled yet; re-check later, do NOT fulfil. */
    case Pending = 'pending';
    /** Declined / error; safe to let the user retry with a NEW order id. */
    case Failed = 'failed';
    /** User backed out. */
    case Canceled = 'canceled';
    /** Session timed out before payment. */
    case Expired = 'expired';
    case Refunded = 'refunded';
    case PartiallyRefunded = 'partially_refunded';
    /** Provider has no record (never started, or wrong env/credentials). */
    case NotFound = 'not_found';
    /** Anything unmapped; treat like pending and alert. */
    case Unknown = 'unknown';
}
