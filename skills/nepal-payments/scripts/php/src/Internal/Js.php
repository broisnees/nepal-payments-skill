<?php

declare(strict_types=1);

namespace NepalPayments\Internal;

/**
 * JavaScript value semantics the TypeScript adapters rely on (truthiness, String(), Number(), UTF-16 length/slice,
 * URLSearchParams / encodeURIComponent encoding), so the PHP port makes the same decisions on the same inputs.
 *
 * @internal
 */
final class Js
{
    private const WS = '[\s\x{00A0}\x{FEFF}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]';

    private function __construct()
    {
    }

    /** JS truthiness: null, false, 0, 0.0, NaN and "" are falsy; "0", [] and objects are truthy. */
    public static function truthy(mixed $v): bool
    {
        if (is_string($v)) {
            return $v !== '';
        }
        if (is_float($v)) {
            return $v !== 0.0 && !is_nan($v);
        }

        return $v !== null && $v !== false && $v !== 0;
    }

    /** JS `String(v)` for JSON-decoded values. */
    public static function toString(mixed $v): string
    {
        return match (true) {
            is_string($v) => $v,
            $v === null => 'null',
            is_bool($v) => $v ? 'true' : 'false',
            is_int($v) => (string) $v,
            is_float($v) => self::numberToString($v),
            is_array($v) && array_is_list($v) => self::join($v, ','),
            default => '[object Object]',
        };
    }

    /** JS `Array.prototype.join` (null elements become ""). @param array<array-key, mixed> $list */
    public static function join(array $list, string $sep): string
    {
        return implode($sep, array_map(static fn (mixed $x): string => $x === null ? '' : self::toString($x), $list));
    }

    /** ECMAScript Number::toString(10): shortest round-trip digits, same exponent thresholds. */
    public static function numberToString(float $x): string
    {
        if (is_nan($x)) {
            return 'NaN';
        }
        if ($x === 0.0) {
            return '0';
        }
        if (is_infinite($x)) {
            return $x > 0 ? 'Infinity' : '-Infinity';
        }
        if ($x < 0) {
            return '-' . self::numberToString(-$x);
        }
        $digits = '';
        $exp = 0;
        for ($p = 0; $p <= 16; $p++) {
            $s = sprintf('%.' . $p . 'e', $x);
            if ((float) $s === $x || $p === 16) {
                [$mant, $e] = explode('e', $s);
                $digits = rtrim(str_replace('.', '', $mant), '0');
                $exp = (int) $e;
                break;
            }
        }
        if ($digits === '') {
            $digits = '0';
        }
        $k = strlen($digits);
        $n = $exp + 1;
        if ($k <= $n && $n <= 21) {
            return $digits . str_repeat('0', $n - $k);
        }
        if (0 < $n && $n <= 21) {
            return substr($digits, 0, $n) . '.' . substr($digits, $n);
        }
        if (-6 < $n && $n <= 0) {
            return '0.' . str_repeat('0', -$n) . $digits;
        }
        $e = $n - 1;
        $sign = $e < 0 ? '-' : '+';

        return ($k === 1 ? $digits : $digits[0] . '.' . substr($digits, 1)) . 'e' . $sign . abs($e);
    }

    /** JS `Number(v)` for JSON-decoded values (strings: trimmed, "" -> 0, hex/octal/binary literals, Infinity). */
    public static function toNumber(mixed $v): float
    {
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if ($v === null || $v === false) {
            return 0.0;
        }
        if ($v === true) {
            return 1.0;
        }
        if (!is_string($v)) {
            return NAN;
        }
        $s = self::trim($v);
        if ($s === '') {
            return 0.0;
        }
        if (preg_match('/^([+-]?)Infinity\z/', $s, $m) === 1) {
            return $m[1] === '-' ? -INF : INF;
        }
        if (preg_match('/^0([xob])([0-9a-f]+)\z/i', $s, $m) === 1) {
            $base = ['x' => 16, 'o' => 8, 'b' => 2][strtolower($m[1])];
            $valid = ['x' => '/^[0-9a-f]+\z/i', 'o' => '/^[0-7]+\z/', 'b' => '/^[01]+\z/'][strtolower($m[1])];
            if (preg_match($valid, $m[2]) !== 1) {
                return NAN;
            }
            $r = 0.0;
            foreach (str_split(strtolower($m[2])) as $c) {
                $r = $r * $base + (float) hexdec($c);
            }

            return $r;
        }
        if (preg_match('/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\z/i', $s) === 1) {
            return (float) $s;
        }

        return NAN;
    }

    /** JS `Math.round` (ties toward +Infinity) to a PHP int; null when not finite or outside the int range. */
    public static function roundToInt(float $x): ?int
    {
        if (!is_finite($x)) {
            return null;
        }
        $r = floor($x);
        if ($x - $r >= 0.5) {
            $r += 1.0;
        }
        if ($r >= 9.2233720368547758E18 || $r < -9.2233720368547758E18) {
            return null;
        }

        return (int) $r;
    }

    /** JS `String.prototype.trim` (ASCII + Unicode whitespace). */
    public static function trim(string $s): string
    {
        $t = trim($s, " \t\n\r\0\x0B\x0C");
        if (preg_match('//u', $t) !== 1) {
            return $t;
        }

        return (string) preg_replace('/^' . self::WS . '+|' . self::WS . '+$/uD', '', $t);
    }

    /** JS `.length` (UTF-16 code units). */
    public static function length(string $s): int
    {
        if (preg_match('/[\x80-\xFF]/', $s) !== 1 || preg_match('//u', $s) !== 1) {
            return strlen($s);
        }

        return (int) preg_match_all('/./su', $s) + (int) preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
    }

    /** JS `.slice(0, n)` counted in UTF-16 code units; never splits a surrogate pair (drops it instead). */
    public static function slice(string $s, int $n): string
    {
        if (preg_match('/[\x80-\xFF]/', $s) !== 1 || preg_match('//u', $s) !== 1) {
            return substr($s, 0, $n);
        }
        $out = '';
        $units = 0;
        foreach ((array) preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
            $w = strlen((string) $ch) === 4 ? 2 : 1;
            if ($units + $w > $n) {
                break;
            }
            $out .= $ch;
            $units += $w;
        }

        return $out;
    }

    /** JS `encodeURIComponent`. */
    public static function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    /** `String(new URLSearchParams(params))` (application/x-www-form-urlencoded, space as "+"). @param array<array-key, string> $params */
    public static function urlSearchParams(array $params): string
    {
        $parts = [];
        foreach ($params as $k => $v) {
            $parts[] = strtr(urlencode((string) $k), ['%2A' => '*']) . '=' . strtr(urlencode($v), ['%2A' => '*']);
        }

        return implode('&', $parts);
    }

    /**
     * Normalize request params to string => string (what TS `Record<string, string>` assumes).
     * null -> "" (Laravel's ConvertEmptyStringsToNull), int/float -> string, arrays/bools/objects dropped.
     *
     * @param array<array-key, mixed> $params
     * @return array<string, string>
     */
    public static function stringMap(array $params): array
    {
        $out = [];
        foreach ($params as $k => $v) {
            if (is_string($v)) {
                $out[(string) $k] = $v;
            } elseif ($v === null) {
                $out[(string) $k] = '';
            } elseif (is_int($v) || is_float($v)) {
                $out[(string) $k] = self::toString($v);
            }
        }

        return $out;
    }

    /** `a || b || c || null` over string params. */
    public static function firstTruthy(?string ...$values): ?string
    {
        foreach ($values as $v) {
            if ($v !== null && $v !== '') {
                return $v;
            }
        }

        return null;
    }
}
