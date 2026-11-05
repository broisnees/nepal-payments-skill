<?php

/**
 * Live sandbox smoke test (port of scripts/ts/test/sandbox.ts). Hits real provider sandboxes; no payment is completed.
 *   php tests/sandbox.php                          # eSewa (public creds) + Fonepay dev sample
 *   KHALTI_SECRET_KEY=... php tests/sandbox.php    # + Khalti (key from test-admin.khalti.com)
 * Exit code 1 if any check fails. Not part of the PHPUnit suite.
 */

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use NepalPayments\Environment;
use NepalPayments\Esewa\EsewaAdapter;
use NepalPayments\Esewa\EsewaConfig;
use NepalPayments\Fonepay\FonepayAdapter;
use NepalPayments\Fonepay\FonepayConfig;
use NepalPayments\InitiateInput;
use NepalPayments\Khalti\KhaltiAdapter;
use NepalPayments\Khalti\KhaltiConfig;
use NepalPayments\Payments;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;

$failed = 0;

function check(string $name, callable $fn): void
{
    global $failed;
    try {
        echo "  ok   {$name}: " . $fn() . "\n";
    } catch (\Throwable $e) {
        $failed++;
        echo "  FAIL {$name}: " . $e->getMessage() . "\n";
    }
}

function ensure(bool $cond, string $msg): void
{
    if (!$cond) {
        throw new \RuntimeException($msg);
    }
}

/**
 * One request WITHOUT following redirects (fetch(..., {redirect: "manual"})).
 *
 * @param array<string, string>|null $form
 * @return array{status: int, location: string, body: string}
 */
function raw(string $url, ?array $form = null): array
{
    $ch = curl_init($url);
    \assert($ch !== false);
    $headers = [];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'nepal-payments-php/1.0 sandbox',
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$headers): int {
            $p = explode(':', $line, 2);
            if (count($p) === 2) {
                $headers[strtolower(trim($p[0]))] = trim($p[1]);
            }

            return strlen($line);
        },
    ]);
    if ($form !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
    }
    $body = curl_exec($ch);
    if (!is_string($body)) {
        throw new \RuntimeException('curl: ' . curl_error($ch));
    }

    return ['status' => (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'location' => $headers['location'] ?? '', 'body' => $body];
}

echo 'PHP ' . PHP_VERSION . "\n";
echo "eSewa (rc sandbox)\n";
$e = new EsewaAdapter(EsewaConfig::sandbox());
$id = Payments::newOrderId();
check('signed form accepted (302 to login)', static function () use ($e, $id): string {
    $f = $e->initiate(new InitiateInput($id, 11050, 'smoke', "https://example.com/payments/esewa/return/{$id}"), taxPaisa: 1000);
    $r = raw($f->action, $f->fields);
    ensure($r['status'] === 302 && str_contains($r['location'], 'bookingId='), "got {$r['status']} {$r['location']} " . substr($r['body'], 0, 200));

    return $r['location'];
});
check('status API: unpaid -> pending', static function () use ($e, $id): string {
    $v = $e->verify(new VerifyInput($id, 11050));
    ensure($v->status === PaymentStatus::Pending, "got {$v->status->value}");

    return $v->status->value;
});
check('status API: wrong total -> not_found', static function () use ($e, $id): string {
    $v = $e->verify(new VerifyInput($id, 99900));
    ensure($v->status === PaymentStatus::NotFound, "got {$v->status->value}");

    return $v->status->value;
});
check('intent book -> status -> cancel', static function () use ($e): string {
    $oid = Payments::newOrderId('I');
    $b = $e->intentBook($oid, 10000, 'https://example.com/cb', 'https://example.com/done');
    $s = $e->intentVerify($oid, $b->providerRef);
    ensure($s->status === PaymentStatus::Pending, "status {$s->status->value}");
    $c = $e->intentCancel($b->providerRef);
    ensure(is_array($c) && is_array($c['data'] ?? null) && ($c['data']['status'] ?? null) === 'CANCELED', 'cancel ' . json_encode($c));

    return "{$b->deeplink} BOOKED -> CANCELED";
});

echo "Fonepay (dev gateway, public sample merchant NBQM)\n";
$fp = new FonepayAdapter(new FonepayConfig(Environment::Sandbox, FonepayConfig::SANDBOX_MERCHANT_CODE, FonepayConfig::SANDBOX_SECRET_KEY));
check('signed redirect accepted (303 to payment page)', static function () use ($fp): string {
    $r = $fp->initiate(new InitiateInput(Payments::newOrderId(), 1050, 'smoke', 'https://example.com/payments/fonepay/return'));
    $res = raw($r->url);
    ensure($res['status'] >= 300 && $res['status'] < 400 && str_contains($res['location'], 'fonepay.com'), "got {$res['status']} {$res['location']} " . substr($res['body'], 0, 200));

    return $res['location'];
});
check('bad DV rejected (409 Data Validation Failed)', static function () use ($fp): string {
    $r = $fp->initiate(new InitiateInput(Payments::newOrderId(), 1050, 'smoke', 'https://example.com/payments/fonepay/return'));
    $url = (string) preg_replace('/([?&]DV=)[0-9A-F]/', '${1}' . '0', $r->url); // flip the first DV hex digit
    $url = $url === $r->url ? (string) preg_replace('/([?&]DV=)[0-9A-F]/', '${1}' . '1', $r->url) : $url;
    $res = raw($url);
    ensure(!($res['status'] >= 300 && $res['status'] < 400) && $res['status'] < 500, "got {$res['status']} {$res['location']} " . substr($res['body'], 0, 200));

    return "{$res['status']} " . substr(trim($res['body']), 0, 80);
});

$khaltiKey = getenv('KHALTI_SECRET_KEY');
if (is_string($khaltiKey) && $khaltiKey !== '') {
    echo "Khalti (dev.khalti.com)\n";
    $k = new KhaltiAdapter(new KhaltiConfig(Environment::Sandbox, $khaltiKey, 'https://example.com'));
    check('initiate -> lookup (Initiated)', static function () use ($k): string {
        $oid = Payments::newOrderId();
        $r = $k->initiate(new InitiateInput($oid, 1000, 'smoke', 'https://example.com/payments/khalti/return'));
        $v = $k->verify(new VerifyInput($oid, 1000, $r->providerRef));
        ensure($v->status === PaymentStatus::Pending, "got {$v->status->value}");

        return "{$r->url} -> " . (is_array($v->raw) ? (string) ($v->raw['status'] ?? '') : '');
    });
} else {
    echo "Khalti: skipped (set KHALTI_SECRET_KEY from https://test-admin.khalti.com)\n";
}

echo $failed > 0 ? "\n{$failed} check(s) failed\n" : "\nall sandbox checks passed\n";
exit($failed > 0 ? 1 : 0);
