<?php

declare(strict_types=1);

namespace NepalPayments\Http;

final class HttpRequest
{
    /**
     * @param 'GET'|'POST' $method
     * @param array<string, string> $headers Final headers (Accept / Content-Type defaults already applied).
     * @param string|null $body Exact bytes to send (already JSON-encoded where applicable); null = no body.
     * @param int $timeoutMs Total timeout for this attempt (connect + send + read).
     */
    public function __construct(
        public readonly string $method,
        public readonly string $url,
        public readonly array $headers,
        public readonly ?string $body,
        public readonly int $timeoutMs,
    ) {
    }
}
