<?php

declare(strict_types=1);

namespace NepalPayments\CyberSource;

use NepalPayments\Environment;

final class CyberSourceConfig
{
    /**
     * @param string $transactionType "sale" (auth+capture, typical) or "authorization" (capture later).
     * @param bool $useReturnUrlOverride Send returnUrl/failureUrl as override_custom_receipt_page / _cancel_page.
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $profileId,
        public readonly string $accessKey,
        public readonly string $secretKey,
        public readonly string $transactionType = 'sale',
        public readonly string $currency = 'NPR',
        public readonly string $locale = 'en-us',
        public readonly bool $useReturnUrlOverride = false,
        public readonly int $timeoutMs = 15_000,
    ) {
    }
}
