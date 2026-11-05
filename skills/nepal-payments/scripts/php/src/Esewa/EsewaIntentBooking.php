<?php

declare(strict_types=1);

namespace NepalPayments\Esewa;

final class EsewaIntentBooking
{
    /** @param string $providerRef "bookingId|correlationId" — persist it on the attempt. */
    public function __construct(
        public readonly string $bookingId,
        public readonly string $deeplink,
        public readonly string $correlationId,
        public readonly string $providerRef,
        public readonly mixed $raw,
    ) {
    }
}
