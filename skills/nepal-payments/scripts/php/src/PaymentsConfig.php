<?php

declare(strict_types=1);

namespace NepalPayments;

use NepalPayments\ConnectIps\ConnectIpsConfig;
use NepalPayments\CyberSource\CyberSourceConfig;
use NepalPayments\Esewa\EsewaConfig;
use NepalPayments\Fonepay\FonepayConfig;
use NepalPayments\ImePay\ImePayConfig;
use NepalPayments\Khalti\KhaltiConfig;
use NepalPayments\NepalPay\NepalPayConfig;
use NepalPayments\Nps\NpsConfig;

/** One optional config per provider; a provider is enabled when its config is set. */
final class PaymentsConfig
{
    public function __construct(
        public readonly ?EsewaConfig $esewa = null,
        public readonly ?KhaltiConfig $khalti = null,
        public readonly ?FonepayConfig $fonepay = null,
        public readonly ?ConnectIpsConfig $connectips = null,
        public readonly ?CyberSourceConfig $cybersource = null,
        public readonly ?NpsConfig $nps = null,
        public readonly ?ImePayConfig $imepay = null,
        public readonly ?NepalPayConfig $nepalpay = null,
    ) {
    }
}
