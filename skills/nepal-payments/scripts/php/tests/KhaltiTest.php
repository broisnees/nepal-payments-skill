<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\InitiateInput;
use NepalPayments\Khalti\KhaltiAdapter;
use NepalPayments\Khalti\KhaltiConfig;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class KhaltiTest extends TestCase
{
    /** @param array<string, mixed> $body */
    private static function adapter(array $body = [], int $status = 200, ?MockTransport &$mock = null): KhaltiAdapter
    {
        return new KhaltiAdapter(
            new KhaltiConfig(Environment::Sandbox, 'live_secret_key_test', 'https://shop.example'),
            MockTransport::client(static fn () => ['status' => $status, 'body' => $body], $mock),
        );
    }

    public function testInitiateIntegerPaisaTrailingSlashKeyHeader(): void
    {
        $k = self::adapter(['pidx' => 'PIDX1', 'payment_url' => 'https://test-pay.khalti.com/?pidx=PIDX1', 'expires_at' => 'x', 'expires_in' => 1800], 200, $mock);
        $r = $k->initiate(new InitiateInput('O1', 1000, 'Book', 'https://shop.example/r'));
        self::assertSame('https://dev.khalti.com/api/v2/epayment/initiate/', $mock->calls[0]->url);
        self::assertSame('Key live_secret_key_test', $mock->header(0, 'Authorization'));
        self::assertSame(1000, $mock->jsonBody(0)['amount']);
        self::assertSame('PIDX1', $r->providerRef);
    }

    public function testMinimumRs10(): void
    {
        $this->expectException(PaymentException::class);
        $this->expectExceptionMessage('minimum');
        self::adapter()->initiate(new InitiateInput('O', 999, 'x', 'https://r'));
    }

    public function testLookupExpiredArrivesAsHttp400WithANormalBody(): void
    {
        $k = self::adapter(['pidx' => 'P', 'total_amount' => 1000, 'status' => 'Expired', 'transaction_id' => null, 'fee' => 0, 'refunded' => false], 400);
        self::assertSame(PaymentStatus::Expired, $k->verify(new VerifyInput('O', 1000, 'P'))->status);
    }

    public function testLookupCompletedUserCanceledPartiallyRefunded(): void
    {
        foreach ([['Completed', 'paid'], ['User canceled', 'canceled'], ['Partially refunded', 'partially_refunded'], ['Initiated', 'pending']] as [$s, $n]) {
            $k = self::adapter(['pidx' => 'P', 'total_amount' => 1000, 'status' => $s, 'transaction_id' => 'T', 'fee' => 0, 'refunded' => false]);
            self::assertSame($n, $k->verify(new VerifyInput('O', 1000, 'P'))->status->value);
        }
    }

    public function testRefusesCallbackPidxThatDiffersFromTheStoredOne(): void
    {
        $this->expectException(PaymentException::class);
        $this->expectExceptionMessage('does not match');
        self::adapter()->verify(new VerifyInput('O', 1000, 'P', ['pidx' => 'OTHER']));
    }

    public function testUnauthorized401(): void
    {
        try {
            self::adapter(['detail' => 'Invalid token.', 'status_code' => 401], 401)->verify(new VerifyInput('O', 1000, 'P'));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('unauthorized', $e->errorCode);
        }
    }

    // ---- Python-only cases

    public function testPythonUserCanceledArrivesAsHttp400(): void
    {
        foreach ([['Completed', 200, 'paid'], ['Expired', 400, 'expired'], ['User canceled', 400, 'canceled'], ['Partially refunded', 200, 'partially_refunded']] as [$s, $code, $n]) {
            $k = self::adapter(['pidx' => 'P', 'total_amount' => 1000, 'status' => $s, 'transaction_id' => 'T', 'fee' => 0, 'refunded' => false], $code);
            $v = $k->verify(new VerifyInput('O', 1000, 'P'));
            self::assertSame($n, $v->status->value);
            self::assertSame(1000, $v->amountPaisa);
        }
    }

    public function testMissingStoredPidxThrowsEvenWithCallbackPidx(): void
    {
        try {
            self::adapter()->verify(new VerifyInput('O', 1000, null, ['pidx' => 'FROM-CALLBACK']));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('missing_pidx', $e->errorCode);
        }
    }
}
