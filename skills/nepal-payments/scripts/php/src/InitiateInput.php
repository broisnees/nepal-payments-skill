<?php

declare(strict_types=1);

namespace NepalPayments;

final class InitiateInput
{
    /**
     * @param string $orderId Unique per payment ATTEMPT (not per order). Provider-safe charset: [A-Za-z0-9-].
     * @param int $amountPaisa Integer paisa, computed server-side from your order.
     * @param string $description Shown to the payer where the provider supports it.
     * @param string $returnUrl Where the provider sends the payer back (your server route).
     * @param string|null $failureUrl Some providers have a separate failure URL; defaults to returnUrl.
     */
    public function __construct(
        public readonly string $orderId,
        public readonly int $amountPaisa,
        public readonly string $description,
        public readonly string $returnUrl,
        public readonly ?string $failureUrl = null,
        public readonly ?Customer $customer = null,
    ) {
    }
}
