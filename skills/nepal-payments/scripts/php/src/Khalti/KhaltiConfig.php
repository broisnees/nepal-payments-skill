<?php

declare(strict_types=1);

namespace NepalPayments\Khalti;

use NepalPayments\Environment;

final class KhaltiConfig
{
    /**
     * @param string $secretKey "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com. A leading "Key " is stripped.
     * @param string $websiteUrl Your site's public URL (required by Khalti).
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $secretKey,
        public readonly string $websiteUrl,
        public readonly int $timeoutMs = 15_000,
    ) {
    }
}
