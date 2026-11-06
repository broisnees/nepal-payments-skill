<?php

declare(strict_types=1);

namespace NepalPayments\NepalPay;

use NepalPayments\Environment;

final class NepalPayConfig
{
    /**
     * @param string $acquirerId 8 digits, e.g. "00002501" (your acquiring bank).
     * @param string $merchantId Creditor id / merchant code, e.g. "2501ELFDRY2".
     * @param string $merchantName <= 25 chars; must match the enrolled name.
     * @param string $username NPI user issued to the merchant. Also the `userId` inside the signed token.
     * @param string $privateKeyPem PKCS#8 PEM extracted from the NPI .pfx (or use
     *        {@see \NepalPayments\ConnectIps\ConnectIpsConfig::privateKeyPemFromPfx()}).
     * @param string $auth "basic" (merchant QR doc) or "oauth" (NPI password grant, needs clientId/clientSecret).
     * @param bool $qrImage Ask NCHL for a base64 PNG alongside the QR string.
     * @param string|null $nchlPublicKeyPem NCHL's public key (SPKI PEM, from NPI.cer): verifies confirm-payment
     *        notifications, encrypts the WebSocket api_token.
     * @param string|null $wsUrl WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own
     *        username ($wsUsername) and API token ($wsApiToken).
     */
    public function __construct(
        public readonly Environment $env,
        public readonly string $acquirerId,
        public readonly string $merchantId,
        public readonly string $merchantName,
        public readonly int|string $merchantCategoryCode,
        public readonly string $merchantCity,
        public readonly string $merchantPostalCode,
        public readonly string $storeLabel,
        public readonly string $username,
        public readonly string $password,
        public readonly string $privateKeyPem,
        public readonly ?string $terminalLabel = null,
        public readonly string $auth = 'basic',
        public readonly ?string $clientId = null,
        public readonly ?string $clientSecret = null,
        public readonly bool $qrImage = true,
        public readonly ?string $nchlPublicKeyPem = null,
        public readonly ?string $wsUrl = null,
        public readonly ?string $wsUsername = null,
        public readonly ?string $wsApiToken = null,
        public readonly ?string $baseUrl = null,
        public readonly int $timeoutMs = 20_000,
    ) {
    }
}
