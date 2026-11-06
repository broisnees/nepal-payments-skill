<?php

declare(strict_types=1);

namespace NepalPayments\HamroPay;

use NepalPayments\Environment;

final class HamroPayConfig
{
    /**
     * @param string|null $webhookSecret Signing secret shown when you save the webhook URL in the merchant portal.
     *        Needed for verifyWebhook().
     * @param string|null $apiBaseUrl API host override. Default UAT https://uat-payclient.hamropatro.com, live
     *        https://payclient.hamropatro.com.
     * @param string|null $gatewayUrl Full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay
     *        issues the live host.
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $merchantId,
        public readonly string $clientId,
        public readonly string $clientApiKey,
        public readonly string $clientSecret,
        public readonly ?string $webhookSecret = null,
        public readonly ?string $apiBaseUrl = null,
        public readonly ?string $gatewayUrl = null,
        public readonly int $timeoutMs = 15_000,
    ) {
    }
}
