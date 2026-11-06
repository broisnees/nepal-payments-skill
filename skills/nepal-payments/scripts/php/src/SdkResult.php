<?php

declare(strict_types=1);

namespace NepalPayments;

/**
 * Load `$scriptUrl` in the browser and start the provider's own checkout with `$options` (GetPay). The adapter
 * ships the page helpers ({@see GetPay\GetPayAdapter::checkoutPage()} / paymentPage() / returnPage()).
 */
final class SdkResult implements InitiateResult
{
    public readonly string $kind;

    /** @param array<string, mixed> $options JSON object handed to the SDK as is. */
    public function __construct(
        public readonly string $scriptUrl,
        public readonly array $options,
        public readonly ?string $providerRef = null,
    ) {
        $this->kind = 'sdk';
    }
}
