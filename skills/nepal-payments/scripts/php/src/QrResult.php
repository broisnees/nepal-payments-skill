<?php

declare(strict_types=1);

namespace NepalPayments;

/**
 * Show a QR the payer scans from their own app (NEPALPAY QR). Render `$qrString` with any QR library, or
 * `<img src="data:image/png;base64,{$qrImage}">` when the provider sent an image. Persist `$providerRef`.
 */
final class QrResult implements InitiateResult
{
    public readonly string $kind;

    public function __construct(
        public readonly string $qrString,
        public readonly string $providerRef,
        public readonly ?string $qrImage = null,
        public readonly mixed $raw = null,
    ) {
        $this->kind = 'qr';
    }
}
