<?php

declare(strict_types=1);

namespace NepalPayments\Esewa;

/** Decoded success-redirect `data`. A valid signature does NOT prove payment; call verify(). */
final class EsewaSuccess
{
    /** @param array<string, mixed> $payload */
    public function __construct(
        public readonly array $payload,
        public readonly bool $signatureValid,
    ) {
    }
}
