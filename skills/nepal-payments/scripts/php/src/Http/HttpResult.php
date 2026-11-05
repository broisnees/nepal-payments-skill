<?php

declare(strict_types=1);

namespace NepalPayments\Http;

final class HttpResult
{
    /**
     * @param mixed $data JSON-decoded body (assoc arrays), the raw text when it isn't JSON, or null for an empty body.
     * @param string $text Raw body text (UTF-8 BOM stripped).
     */
    public function __construct(
        public readonly int $status,
        public readonly mixed $data,
        public readonly string $text,
    ) {
    }
}
