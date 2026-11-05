<?php

declare(strict_types=1);

namespace NepalPayments\Internal;

/** @internal */
final class Json
{
    private function __construct()
    {
    }

    /** JSON.stringify-compatible encoding (no "/" or Unicode escaping; shortest float repr). */
    public static function encode(mixed $value): string
    {
        $prev = ini_get('serialize_precision');
        ini_set('serialize_precision', '-1');
        try {
            return json_encode(
                $value,
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR,
            );
        } finally {
            ini_set('serialize_precision', $prev === false ? '-1' : $prev);
        }
    }

    /**
     * JSON.parse into PHP arrays. Big integers stay exact (as strings); invalid UTF-8 becomes U+FFFD like TextDecoder.
     *
     * @throws \JsonException
     */
    public static function decode(string $text): mixed
    {
        return json_decode($text, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING | JSON_INVALID_UTF8_SUBSTITUTE);
    }
}
