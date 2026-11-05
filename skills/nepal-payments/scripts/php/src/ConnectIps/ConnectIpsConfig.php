<?php

declare(strict_types=1);

namespace NepalPayments\ConnectIps;

use NepalPayments\Crypto;
use NepalPayments\Environment;
use NepalPayments\PaymentException;
use NepalPayments\ProviderId;

final class ConnectIpsConfig
{
    /**
     * @param int|string $merchantId MERCHANTID from NCHL.
     * @param string $appId e.g. "MER-550-APP-1".
     * @param string $appName <= 30 chars.
     * @param string $appPassword App password for Basic auth on validatetxn / gettxndetail.
     * @param string $privateKeyPem Creditor private key, PKCS#8 ("BEGIN PRIVATE KEY") or PKCS#1 PEM.
     *        Or build the config from the .pfx directly with {@see fromPfx()}.
     */
    public function __construct(
        public readonly Environment $env,
        public readonly int|string $merchantId,
        public readonly string $appId,
        public readonly string $appName,
        public readonly string $appPassword,
        public readonly string $privateKeyPem,
        public readonly ?string $baseUrl = null,
        public readonly int $timeoutMs = 20_000,
    ) {
    }

    /**
     * Same as the constructor, but loads the creditor key from the .pfx NCHL sent you.
     *
     * @param string $pfx The .pfx file CONTENTS (e.g. file_get_contents(storage_path('app/CREDITOR.pfx'))).
     * @throws PaymentException pfx_legacy_encryption | pfx_bad_password | pfx_invalid
     */
    public static function fromPfx(
        Environment $env,
        int|string $merchantId,
        string $appId,
        string $appName,
        string $appPassword,
        string $pfx,
        string $pfxPassword,
        ?string $baseUrl = null,
        int $timeoutMs = 20_000,
    ): self {
        return new self($env, $merchantId, $appId, $appName, $appPassword, self::privateKeyPemFromPfx($pfx, $pfxPassword), $baseUrl, $timeoutMs);
    }

    /**
     * Extract the private key from a .pfx/.p12 as a PEM string (do it once at boot, not per request).
     *
     * @throws PaymentException
     */
    public static function privateKeyPemFromPfx(string $pfx, string $password): string
    {
        Crypto::clearOpenSslErrors();
        $certs = [];
        if (!openssl_pkcs12_read($pfx, $certs, $password)) {
            $err = Crypto::openSslErrors();
            if (str_contains($err, 'unsupported') || str_contains($err, 'RC2')) {
                throw new PaymentException(
                    'connectIPS: this .pfx uses legacy RC2/3DES encryption that OpenSSL 3 does not load by default. Convert it once: '
                    . 'openssl pkcs12 -legacy -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem '
                    . "and pass the PEM as privateKeyPem (OpenSSL: {$err})",
                    ProviderId::ConnectIps,
                    'pfx_legacy_encryption',
                    null,
                    $err,
                );
            }
            if (str_contains($err, 'mac verify failure')) {
                throw new PaymentException('connectIPS: wrong .pfx password', ProviderId::ConnectIps, 'pfx_bad_password', null, $err);
            }
            throw new PaymentException("connectIPS: cannot read .pfx ({$err})", ProviderId::ConnectIps, 'pfx_invalid', null, $err);
        }
        $pkey = $certs['pkey'] ?? null;
        if (!is_string($pkey) || $pkey === '') {
            throw new PaymentException('connectIPS: no private key in .pfx', ProviderId::ConnectIps, 'pfx_invalid');
        }

        return $pkey;
    }
}
