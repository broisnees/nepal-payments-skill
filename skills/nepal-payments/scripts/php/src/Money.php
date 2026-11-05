<?php

declare(strict_types=1);

namespace NepalPayments;

use NepalPayments\Internal\Js;

/** Money is integer paisa everywhere; convert only at the edge. No floats. */
final class Money
{
    /** Number.MAX_SAFE_INTEGER, the TS upper bound for paisa. */
    public const MAX_PAISA = 9_007_199_254_740_991;

    private function __construct()
    {
    }

    /** @throws PaymentException invalid_amount */
    public static function assertPaisa(int $paisa, ProviderId $provider): void
    {
        if ($paisa <= 0 || $paisa > self::MAX_PAISA) {
            throw new PaymentException("amount must be a positive integer in paisa, got {$paisa}", $provider, 'invalid_amount');
        }
    }

    /** 12345 -> "123.45", 10000 -> "100". */
    public static function paisaToRupees(int $paisa): string
    {
        $sign = $paisa < 0 ? '-' : '';
        $abs = $paisa < 0 ? -$paisa : $paisa;
        $rupees = intdiv($abs, 100);
        $rem = $abs % 100;

        return $rem === 0 ? $sign . $rupees : sprintf('%s%d.%02d', $sign, $rupees, $rem);
    }

    /** 12345 -> "123.45", 10000 -> "100.00" (always two decimals; CyberSource / IME Pay). */
    public static function paisaToRupees2dp(int $paisa): string
    {
        $sign = $paisa < 0 ? '-' : '';
        $abs = $paisa < 0 ? -$paisa : $paisa;

        return sprintf('%s%d.%02d', $sign, intdiv($abs, 100), $abs % 100);
    }

    /**
     * "123.45" | 123.45 | "1,000.0" | "100" -> paisa integer. Rounds half away from zero on the 3rd decimal.
     * Floats are read through their shortest decimal form (1.005 -> "1.005" -> 101), never through float math.
     *
     * @throws \InvalidArgumentException when the value is not a plain decimal rupee amount
     */
    public static function rupeesToPaisa(string|int|float $rupees): int
    {
        $s = match (true) {
            is_int($rupees) => (string) $rupees,
            is_float($rupees) => Js::numberToString($rupees),
            default => str_replace(',', '', Js::trim($rupees)),
        };
        if (preg_match('/^(-?)(\d+)(?:\.(\d+))?\z/', $s, $m) !== 1) {
            throw new \InvalidArgumentException('not a rupee amount: ' . (is_string($rupees) ? $rupees : Js::toString($rupees)));
        }
        $whole = ltrim($m[2], '0');
        if (strlen($whole) > 16) {
            throw new \InvalidArgumentException("rupee amount out of range: {$s}");
        }
        $f = substr(($m[3] ?? '') . '000', 0, 3);
        $p = (int) ($whole === '' ? '0' : $whole) * 100 + (int) substr($f, 0, 2);
        if ((int) $f[2] >= 5) {
            $p++;
        }

        return $m[1] === '-' ? -$p : $p;
    }
}
