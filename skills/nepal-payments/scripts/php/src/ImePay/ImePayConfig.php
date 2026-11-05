<?php

declare(strict_types=1);

namespace NepalPayments\ImePay;

use NepalPayments\Environment;

final class ImePayConfig
{
    public function __construct(
        public readonly Environment $env,
        public readonly string $merchantCode,
        public readonly string $username,
        public readonly string $password,
        public readonly string $module,
        public readonly ?string $baseUrl = null,
        public readonly int $timeoutMs = 20_000,
    ) {
    }
}
