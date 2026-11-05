<?php

declare(strict_types=1);

namespace NepalPayments\Fonepay;

use NepalPayments\Environment;

final class FonepayConfig
{
    public const SANDBOX_MERCHANT_CODE = 'NBQM';
    public const SANDBOX_SECRET_KEY = 'a7e3512f5032480a83137793cb2021dc';

    /**
     * @param string $merchantCode PID / merchant code (3–20 chars). Public dev sample: "NBQM".
     * @param string $secretKey HMAC secret from the merchant profile page.
     * @param string|null $username Merchant-panel login — required for txnVerification (recommended) and Dynamic QR.
     * @param string|null $paymentUrl Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank).
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $merchantCode,
        public readonly string $secretKey,
        public readonly ?string $username = null,
        public readonly ?string $password = null,
        public readonly ?string $paymentUrl = null,
        public readonly ?string $txnVerificationUrl = null,
        public readonly ?string $legacyVerifyUrl = null,
        public readonly ?string $qrBaseUrl = null,
        public readonly bool $strictSignature = true,
        public readonly int $timeoutMs = 15_000,
    ) {
    }
}
