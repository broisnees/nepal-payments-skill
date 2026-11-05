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
