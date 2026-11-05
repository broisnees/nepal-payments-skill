<?php

declare(strict_types=1);

namespace NepalPayments;

/**
 * Redirect the browser (or open a WebView / Custom Tab) to `$url`.
 * `$providerRef` (e.g. Khalti pidx, IME TokenId) MUST be persisted on the attempt; verify() needs it.
 */
final class RedirectResult implements InitiateResult
{
    public readonly string $kind;

    public function __construct(
        public readonly string $url,
        public readonly ?string $providerRef = null,
        public readonly ?string $expiresAt = null,
        public readonly mixed $raw = null,
    ) {
        $this->kind = 'redirect';
    }
}
