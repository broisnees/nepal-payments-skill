<?php

declare(strict_types=1);

namespace NepalPayments\GetPay;

use NepalPayments\Environment;

final class GetPayConfig
{
    /**
     * @param string $papInfo Base64 {"institutionId","mid","tid"} from the bank.
     * @param string $oprKey Operator key from the bank. It also reaches the browser (GetPay's design); it is not a secret.
     * @param string $websiteDomain Your site origin, e.g. "https://shop.example". GetPay requires the callback URLs on this host.
     * @param string $imageUrl Logo shown on the checkout page (absolute URL).
     * @param string|null $insKey Blank when operator-hosted.
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $papInfo,
        public readonly string $oprKey,
        public readonly string $websiteDomain,
        public readonly string $businessName,
        public readonly string $imageUrl,
        public readonly ?string $insKey = null,
        public readonly ?string $currency = null,
        public readonly ?string $themeColor = null,
        public readonly ?string $bundleUrl = null,
        public readonly ?string $baseUrl = null,
        public readonly int $timeoutMs = 20_000,
    ) {
    }
}
