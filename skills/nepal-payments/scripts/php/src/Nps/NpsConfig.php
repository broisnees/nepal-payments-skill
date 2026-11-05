<?php

declare(strict_types=1);

namespace NepalPayments\Nps;

use NepalPayments\Environment;

final class NpsConfig
{
    public function __construct(
        public readonly Environment $env,
        public readonly string $merchantId,
        public readonly string $merchantName,
        public readonly string $apiUsername,
        public readonly string $apiPassword,
        public readonly string $secretKey,
        public readonly ?string $apiBaseUrl = null,
        public readonly ?string $gatewayUrl = null,
        public readonly int $timeoutMs = 20_000,
    ) {
    }
}
