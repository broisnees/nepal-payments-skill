<?php

declare(strict_types=1);

namespace NepalPayments;

use NepalPayments\Internal\Json;

final class Crypto
{
    private function __construct()
    {
    }

    public static function toBase64(string $bytes): string
    {
        return base64_encode($bytes);
    }

    /**
     * Tolerates the url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers.
     *
     * @throws \InvalidArgumentException on invalid base64
     */
    public static function fromBase64(string $b64): string
    {
        // Spaces back to "+" BEFORE trimming, or a leading/trailing "+" is lost.
        $s = strtr(trim(str_replace(' ', '+', $b64), " \t\n\r\0\x0B\x0C"), '-_', '+/');
        $pad = strlen($s) % 4;
        if ($pad !== 0) {
            $s .= str_repeat('=', 4 - $pad);
        }
        $out = base64_decode($s, true);
        if ($out === false) {
            throw new \InvalidArgumentException('invalid base64');
        }

        return $out;
    }

    /**
     * @throws \InvalidArgumentException|\JsonException
     */
    public static function base64Json(string $b64): mixed
    {
        return Json::decode(self::fromBase64($b64));
    }

    public static function toHex(string $bytes): string
    {
        return bin2hex($bytes);
    }

    /** Raw HMAC bytes. @param 'sha256'|'sha512' $algo */
    public static function hmac(string $algo, string $key, string $message): string
    {
        return hash_hmac($algo, $message, $key, true);
    }

    /** Raw SHA-256 bytes. */
    public static function sha256(string $data): string
    {
        return hash('sha256', $data, true);
    }

    /** Constant-time string comparison (avoid leaking signature prefixes via timing). */
    public static function safeEqual(string $a, string $b): bool
    {
        return hash_equals($a, $b);
    }

    /**
     * RSA PKCS#1 v1.5 + SHA-256 signature, base64 output. Accepts a PKCS#8 ("BEGIN PRIVATE KEY") or
     * PKCS#1 ("BEGIN RSA PRIVATE KEY") PEM. For a connectIPS .pfx use {@see ConnectIps\ConnectIpsConfig::fromPfx()}.
     *
     * @throws \InvalidArgumentException when the key can't be loaded or signing fails
     */
    public static function rsaSha256SignBase64(string $privateKeyPem, string $message): string
    {
        self::clearOpenSslErrors();
        $key = openssl_pkey_get_private($privateKeyPem);
        if ($key === false) {
            throw new \InvalidArgumentException('cannot load RSA private key (expected PKCS#8 PEM): ' . self::openSslErrors());
        }
        $signature = '';
        if (!openssl_sign($message, $signature, $key, OPENSSL_ALGO_SHA256)) {
            throw new \InvalidArgumentException('RSA-SHA256 signing failed: ' . self::openSslErrors());
        }

        return base64_encode($signature);
    }

    /**
     * Verify an RSA PKCS#1 v1.5 + SHA-256 signature (base64) with an SPKI ("BEGIN PUBLIC KEY") PEM.
     * False on any malformed input. From a certificate (.cer/.crt):
     *   openssl x509 -in NPI.cer [-inform der] -pubkey -noout > npi.pub.pem
     */
    public static function rsaSha256VerifyBase64(string $spkiPem, string $message, string $signatureB64): bool
    {
        self::clearOpenSslErrors();
        try {
            $key = self::spkiKey($spkiPem);
            $ok = openssl_verify($message, self::fromBase64($signatureB64), $key, OPENSSL_ALGO_SHA256) === 1;
        } catch (\InvalidArgumentException) {
            $ok = false;
        }
        self::clearOpenSslErrors();

        return $ok;
    }

    /**
     * RSA PKCS#1 v1.5 encryption ("RSA/ECB/PKCS1Padding") with an SPKI PEM, base64 output.
     *
     * @throws \InvalidArgumentException when the key can't be loaded or the plaintext is too long for the key
     */
    public static function rsaPkcs1EncryptBase64(string $spkiPem, string $plaintext): string
    {
        self::clearOpenSslErrors();
        $key = self::spkiKey($spkiPem);
        $k = intdiv((int) (openssl_pkey_get_details($key)['bits'] ?? 0) + 7, 8);
        if (strlen($plaintext) > $k - 11) {
            throw new \InvalidArgumentException(sprintf('plaintext too long for a %d-bit RSA key (max %d bytes)', $k * 8, $k - 11));
        }
        $out = '';
        if (!openssl_public_encrypt($plaintext, $out, $key, OPENSSL_PKCS1_PADDING)) {
            throw new \InvalidArgumentException('RSA PKCS#1 v1.5 encryption failed: ' . self::openSslErrors());
        }

        return base64_encode($out);
    }

    /** @throws \InvalidArgumentException */
    private static function spkiKey(string $spkiPem): \OpenSSLAsymmetricKey
    {
        if (!str_contains($spkiPem, 'BEGIN PUBLIC KEY')) {
            throw new \InvalidArgumentException('expected a PUBLIC KEY PEM; extract it from the certificate with: openssl x509 -in NPI.cer -pubkey -noout');
        }
        $key = openssl_pkey_get_public($spkiPem);
        if ($key === false) {
            throw new \InvalidArgumentException('cannot load RSA public key: ' . self::openSslErrors());
        }

        return $key;
    }

    /** Basic auth header value (UTF-8 credentials). */
    public static function basicAuth(string $user, string $pass): string
    {
        return 'Basic ' . base64_encode("{$user}:{$pass}");
    }

    /** @internal */
    public static function clearOpenSslErrors(): void
    {
        while (openssl_error_string() !== false) {
            // drain the queue so later messages belong to the next call
        }
    }

    /** @internal */
    public static function openSslErrors(): string
    {
        $all = [];
        while (($e = openssl_error_string()) !== false) {
            $all[] = $e;
        }

        return $all === [] ? 'unknown OpenSSL error' : implode('; ', $all);
    }
}
