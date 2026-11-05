<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\Fonepay\FonepayAdapter;
use NepalPayments\Fonepay\FonepayConfig;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class FonepayTest extends TestCase
{
    private const SECRET = 'a7e3512f5032480a83137793cb2021dc'; // public dev sample (spec v2.0)
    private const FIELDS = ['PRN', 'PID', 'PS', 'RC', 'UID', 'BC', 'INI', 'P_AMT', 'R_AMT'];

    /** @param array<string, mixed>|string $body */
    private static function fp(FonepayConfig $cfg, array|string $body = [], int $status = 200, ?MockTransport &$mock = null): FonepayAdapter
    {
        return new FonepayAdapter($cfg, MockTransport::client(static fn () => ['status' => $status, 'body' => $body], $mock));
    }

    private static function cfg(Environment $env = Environment::Sandbox, ?string $user = null, ?string $pass = null, bool $strict = true): FonepayConfig
    {
        return new FonepayConfig($env, 'NBQM', self::SECRET, $user, $pass, strictSignature: $strict);
    }

    /** @param array<string, string> $cb @return array<string, string> */
    private static function withDv(array $cb): array
    {
        $cb['DV'] = FonepayAdapter::hmac(self::SECRET, array_map(static fn (string $k): string => $cb[$k], self::FIELDS));

        return $cb;
    }

    public function testResponseDvTestVector(): void
    {
        self::assertSame(
            '667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52',
            FonepayAdapter::hmac(self::SECRET, ['d1580724437729', 'NBQM', 'true', 'successful', '36463', 'NICENPKA', '9841845631', '20.0', '30']),
        );
    }

    public function testTxnVerificationAuthHeaderMatchesSpecExampleByteForByte(): void
    {
        $fp = self::fp(self::cfg(Environment::Production, 'gnw71090@zwoho.com', 'Fonepay@12345'), ['paymentStatus' => 'success', 'prn' => 'd1549791827186', 'requestedAmount' => '30', 'fonepayTraceId' => 12847], 200, $mock);
        $v = $fp->verify(new VerifyInput('d1549791827186', 3000));
        self::assertSame('{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}', $mock->calls[0]->body);
        self::assertSame('0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2', $mock->header(0, 'auth'));
        self::assertSame('Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=', $mock->header(0, 'Authorization'));
        self::assertSame(PaymentStatus::Paid, $v->status);
        self::assertSame(3000, $v->amountPaisa);
        self::assertSame('12847', $v->transactionId); // Python: str(fonepayTraceId)
    }

    public function testDynamicQrDataValidationMatchesSpecExample(): void
    {
        $fp = self::fp(self::cfg(Environment::Production, 'u', 'p'), ['qrMessage' => '000201...', 'status' => 'CREATED', 'thirdpartyQrWebSocketUrl' => 'wss://localhost:8080/x'], 200, $mock);
        $r = $fp->qrCreate('5d76d323-d1f6', 1400, 'test1', 'test2');
        self::assertSame(
            '5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf',
            $mock->jsonBody(0)['dataValidation'],
        );
        self::assertSame('wss://ws.fonepay.com/x', $r->webSocketUrl); // localhost host rewritten
    }

    public function testInitiateDvOverRawValuesPrnLengthEnforcedKathmanduDate(): void
    {
        $fp = self::fp(self::cfg());
        $r = $fp->initiate(new InitiateInput('NP123', 1050, 'Order 1', 'https://s.example/r'));
        self::assertSame('redirect', $r->kind);
        parse_str((string) parse_url($r->url, PHP_URL_QUERY), $q);
        self::assertSame('10.50', $q['AMT']);
        self::assertMatchesRegularExpression('~^\d{2}/\d{2}/\d{4}$~', $q['DT']);
        self::assertSame(FonepayAdapter::hmac(self::SECRET, ['NBQM', 'P', 'NP123', '10.50', 'NPR', $q['DT'], 'Order 1', 'N/A', 'https://s.example/r']), $q['DV']);
        try {
            $fp->initiate(new InitiateInput(str_repeat('X', 26), 100, 'x', 'https://r'));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertStringContainsString('3–25', $e->getMessage());
        }
        self::assertSame('11/05/2026', FonepayAdapter::date(new \DateTimeImmutable('2026-11-04T20:00:00Z'))); // already the 5th in Nepal (UTC+5:45)
    }

    public function testForgedCallbackWithoutDvCannotForceFailedLegacyPath(): void
    {
        $forged = ['PRN' => 'NP123', 'PID' => 'NBQM', 'PS' => 'false', 'RC' => 'failed', 'UID' => 'x', 'BC' => 'y'];
        try {
            self::fp(self::cfg())->verify(new VerifyInput('NP123', 1000, null, $forged));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('invalid_signature', $e->errorCode);
        }
        try {
            self::fp(self::cfg(strict: false))->verify(new VerifyInput('NP123', 1000, null, $forged));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('verify_unavailable', $e->errorCode);
        }
    }

    public function testLegacyVerificationUpstream5xxThrowsInsteadOfReadingAsFailed(): void
    {
        $cb = self::withDv(['PRN' => 'NP123', 'PID' => 'NBQM', 'PS' => 'true', 'RC' => 'successful', 'UID' => '36463', 'BC' => 'NICENPKA', 'INI' => '98', 'P_AMT' => '10', 'R_AMT' => '10']);
        try {
            self::fp(self::cfg(), '<html>Bad Gateway</html>', 502, $mock)->verify(new VerifyInput('NP123', 1000, null, $cb));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('upstream_error', $e->errorCode);
        }
        self::assertCount(3, $mock->calls); // retried twice, then surfaced
        $v = self::fp(self::cfg(), '<response><response_code>successful</response_code><success>true</success></response>')->verify(new VerifyInput('NP123', 1000, null, $cb));
        self::assertSame(PaymentStatus::Paid, $v->status);
        self::assertSame(1000, $v->amountPaisa);
    }

    public function testCallbackDvVerifiedCaseInsensitivelyTamperRejected(): void
    {
        $fp = self::fp(self::cfg());
        $cb = ['PRN' => 'd1580724437729', 'PID' => 'NBQM', 'PS' => 'true', 'RC' => 'successful', 'UID' => '36463', 'BC' => 'NICENPKA', 'INI' => '9841845631', 'P_AMT' => '20.0', 'R_AMT' => '30'];
        $cb['DV'] = strtolower(FonepayAdapter::hmac(self::SECRET, array_values($cb)));
        self::assertTrue($fp->callbackValid($cb));
        self::assertFalse($fp->callbackValid(['R_AMT' => '3'] + $cb));
    }

    // ---- brief behaviours not covered by the TS/Python tests

    public function testLegacyUnparseableResponseThrows(): void
    {
        $cb = self::withDv(['PRN' => 'NP123', 'PID' => 'NBQM', 'PS' => 'true', 'RC' => 'successful', 'UID' => '1', 'BC' => 'B', 'INI' => '9', 'P_AMT' => '10', 'R_AMT' => '10']);
        try {
            self::fp(self::cfg(), '<html>maintenance</html>')->verify(new VerifyInput('NP123', 1000, null, $cb));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('malformed_response', $e->errorCode);
        }
    }

    public function testAuthenticNegativeCallbackAndDvForAnotherAttempt(): void
    {
        $cancel = self::withDv(['PRN' => 'NP123', 'PID' => 'NBQM', 'PS' => 'false', 'RC' => 'cancel', 'UID' => 'U1', 'BC' => 'B', 'INI' => '9', 'P_AMT' => '10', 'R_AMT' => '10']);
        $v = self::fp(self::cfg(), [], 200, $mock)->verify(new VerifyInput('NP123', 1000, null, $cancel));
        self::assertSame(PaymentStatus::Canceled, $v->status);
        self::assertSame('U1', $v->transactionId);
        self::assertCount(0, $mock->calls); // DV-verified negative outcome needs no call
        try {
            self::fp(self::cfg())->verify(new VerifyInput('OTHER-1', 1000, null, $cancel));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('callback_mismatch', $e->errorCode);
        }
    }

    public function testQrStatusUsesStoredAmount(): void
    {
        $fp = self::fp(self::cfg(Environment::Sandbox, 'u', 'p'), ['paymentStatus' => 'success', 'fonepayTraceId' => 9], 200, $mock);
        $v = $fp->qrStatus('5d76d323-d1f6', 1400);
        self::assertSame([PaymentStatus::Paid, 1400, '9'], [$v->status, $v->amountPaisa, $v->transactionId]);
        self::assertSame(strtolower(FonepayAdapter::hmac(self::SECRET, ['5d76d323-d1f6', 'NBQM'])), $mock->jsonBody(0)['dataValidation']);
        self::assertSame('wss://dev-ws.fonepay.com/x', self::fp(self::cfg(Environment::Sandbox, 'u', 'p'), ['qrMessage' => '0002', 'thirdpartyQrWebSocketUrl' => 'ws://localhost:1/x'])->qrCreate('P1', 100, 'r')->webSocketUrl);
    }
}
