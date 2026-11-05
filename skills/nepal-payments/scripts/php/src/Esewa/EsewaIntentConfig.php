<?php

declare(strict_types=1);

namespace NepalPayments\Esewa;

final class EsewaIntentConfig
{
    /**
     * @param string $accessKey Use as a raw string, NOT base64-decoded.
     * @param string|null $baseUrl Production Intent host is issued by eSewa at go-live.
     */
    public function __construct(
        public readonly string $productCode,
        public readonly string $accessKey,
        public readonly ?string $baseUrl = null,
    ) {
    }
}
