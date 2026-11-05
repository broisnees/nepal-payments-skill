<?php

declare(strict_types=1);

namespace NepalPayments\Esewa;

use NepalPayments\Environment;

final class EsewaConfig
{
    public const SANDBOX_PRODUCT_CODE = 'EPAYTEST';
    public const SANDBOX_SECRET_KEY = '8gBm/:&EnhH.1/q';
    public const SANDBOX_INTENT_PRODUCT_CODE = 'INTENT';
    /** Use as a raw string, NOT base64-decoded. */
    public const SANDBOX_INTENT_ACCESS_KEY = 'LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==';

    /**
     * @param string $productCode ePay product code. Sandbox: "EPAYTEST".
     * @param string $secretKey ePay secret key. "&amp;" is unescaped (config UIs sometimes HTML-escape it).
     * @param EsewaIntentConfig|null $intent Only needed for intentBook() & co.
     * @param bool $strictSignature Throw when the success-redirect signature doesn't verify. Status API is checked regardless.
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $productCode,
        public readonly string $secretKey,
        public readonly ?EsewaIntentConfig $intent = null,
        public readonly ?string $formUrl = null,
        public readonly ?string $statusUrl = null,
        public readonly bool $strictSignature = true,
        public readonly int $timeoutMs = 15_000,
    ) {
    }

    /** Public sandbox credentials (ePay + Intent). */
    public static function sandbox(): self
    {
        return new self(
            Environment::Sandbox,
            self::SANDBOX_PRODUCT_CODE,
            self::SANDBOX_SECRET_KEY,
            new EsewaIntentConfig(self::SANDBOX_INTENT_PRODUCT_CODE, self::SANDBOX_INTENT_ACCESS_KEY),
        );
    }
}
