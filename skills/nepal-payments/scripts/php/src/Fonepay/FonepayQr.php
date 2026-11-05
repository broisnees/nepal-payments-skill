<?php

declare(strict_types=1);

namespace NepalPayments\Fonepay;

final class FonepayQr
{
    /**
     * @param string $qrMessage Render as a QR code (EMV / NepalQR string).
     * @param string|null $webSocketUrl Listen for "paymentSuccess", then confirm with qrStatus() before fulfilling.
     */
    public function __construct(
        public readonly string $qrMessage,
        public readonly ?string $webSocketUrl,
        public readonly mixed $raw,
    ) {
    }
}
