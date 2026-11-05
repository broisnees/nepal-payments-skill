<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\ConnectIps\ConnectIpsAdapter;
use NepalPayments\ConnectIps\ConnectIpsConfig;
use NepalPayments\Crypto;
use NepalPayments\Environment;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class ConnectIpsTest extends TestCase
{
    private static ?\OpenSSLAsymmetricKey $key = null;
    private static string $pem = '';

    public static function setUpBeforeClass(): void
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($key);
        self::$key = $key;
        openssl_pkey_export($key, $pem);
        self::$pem = (string) $pem;
        self::assertStringStartsWith('-----BEGIN PRIVATE KEY-----', self::$pem); // PKCS#8
    }

    /** @param array<string, mixed> $body */
    private static function adapter(array $body = [], int $status = 200, ?MockTransport &$mock = null, ?string $pem = null): ConnectIpsAdapter
    {
        return new ConnectIpsAdapter(
            new ConnectIpsConfig(Environment::Sandbox, 550, 'MER-550-APP-1', 'Test', 'pw', $pem ?? self::$pem),
            MockTransport::client(static fn () => ['status' => $status, 'body' => $body], $mock),
        );
    }

    private static function publicKey(): \OpenSSLAsymmetricKey
    {
        \assert(self::$key !== null);
        $pub = openssl_pkey_get_public((string) openssl_pkey_get_details(self::$key)['key']);
        self::assertNotFalse($pub);

        return $pub;
    }

    public function testTokenIsRsaSha256OverTheDocumentedStringAmountInPaisaDdMmYyyy(): void
    {
        $r = self::adapter()->initiate(new InitiateInput('txn123', 500, 'Order, #1', ''));
        self::assertSame('form', $r->kind);
        self::assertSame('500', $r->fields['TXNAMT']);
        self::assertMatchesRegularExpression('/^\d{2}-\d{2}-\d{4}$/', $r->fields['TXNDATE']);
        self::assertSame('Order  #1', $r->fields['REMARKS']); // commas stripped: they'd corrupt the token string
        $msg = ConnectIpsAdapter::tokenString($r->fields);
        self::assertStringEndsWith(',PARTICULARS=Order  #1,TOKEN=TOKEN', $msg);
        self::assertSame(1, openssl_verify($msg, Crypto::fromBase64($r->fields['TOKEN']), self::publicKey(), OPENSSL_ALGO_SHA256));
    }

    public function testTxnIdMax20Chars(): void
    {
        $this->expectException(PaymentException::class);
        $this->expectExceptionMessage('1–20');
        self::adapter()->initiate(new InitiateInput(str_repeat('X', 21), 100, 'x', ''));
    }

    public function testValidatetxnReferenceIdIsTxnIdBasicAuthStatusMapping(): void
    {
        foreach ([['SUCCESS', 'TRANSACTION SUCCESSFUL', 'paid'], ['FAILED', 'TRANSACTION UNSUCCESSFUL', 'failed'], ['ERROR', 'TRANSACTION NOT FOUND', 'not_found'], ['ERROR', 'TRANSACTION INCOMPLETE', 'pending']] as [$status, $desc, $n]) {
            $c = self::adapter(['merchantId' => 550, 'appId' => 'MER-550-APP-1', 'referenceId' => 'txn123', 'txnAmt' => '500', 'status' => $status, 'statusDesc' => $desc], 200, $mock);
            $v = $c->verify(new VerifyInput('txn123', 500));
            self::assertSame($n, $v->status->value);
            $body = $mock->jsonBody(0);
            self::assertSame('txn123', $body['referenceId']);
            self::assertSame(500, $body['txnAmt']);
            self::assertSame('Basic ' . base64_encode('MER-550-APP-1:pw'), $mock->header(0, 'Authorization'));
            self::assertSame('https://uat.connectips.com/connectipswebws/api/creditor/validatetxn', $mock->calls[0]->url);
        }
    }

    // ---- brief behaviours not covered by the TS/Python tests

    public function testValidationTokenIsSignedAndAmountIsRead(): void
    {
        $c = self::adapter(['referenceId' => 'txn123', 'txnAmt' => '500', 'status' => 'SUCCESS', 'statusDesc' => 'TRANSACTION SUCCESSFUL'], 200, $mock);
        $v = $c->verify(new VerifyInput('txn123', 500));
        self::assertSame([PaymentStatus::Paid, 500], [$v->status, $v->amountPaisa]);
        $body = $mock->jsonBody(0);
        self::assertSame(550, $body['merchantId']);
        self::assertSame(1, openssl_verify('MERCHANTID=550,APPID=MER-550-APP-1,REFERENCEID=txn123,TXNAMT=500', Crypto::fromBase64($body['token']), self::publicKey(), OPENSSL_ALGO_SHA256));
    }

    // ---- .pfx support (PHP)

    public function testPfxIsLoadedDirectly(): void
    {
        \assert(self::$key !== null);
        $csr = openssl_csr_new(['commonName' => 'nepal-payments-test'], self::$key);
        self::assertNotFalse($csr);
        $cert = openssl_csr_sign($csr, null, self::$key, 1);
        self::assertNotFalse($cert);
        self::assertTrue(openssl_pkcs12_export($cert, $pfx, self::$key, 'secret'));

        $cfg = ConnectIpsConfig::fromPfx(Environment::Sandbox, 550, 'MER-550-APP-1', 'Test', 'pw', (string) $pfx, 'secret');
        $r = (new ConnectIpsAdapter($cfg, MockTransport::client(static fn () => ['body' => []])))->initiate(new InitiateInput('txn123', 500, 'x', ''));
        self::assertSame(1, openssl_verify(ConnectIpsAdapter::tokenString($r->fields), Crypto::fromBase64($r->fields['TOKEN']), self::publicKey(), OPENSSL_ALGO_SHA256));

        try {
            ConnectIpsConfig::privateKeyPemFromPfx((string) $pfx, 'wrong');
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('pfx_bad_password', $e->errorCode);
        }
    }

    public function testLegacyRc2PfxGivesAClearConversionHint(): void
    {
        $pfx = (string) file_get_contents(__DIR__ . '/fixtures/legacy-rc2.pfx');
        try {
            $pem = ConnectIpsConfig::privateKeyPemFromPfx($pfx, 'test');
            self::assertStringContainsString('PRIVATE KEY', $pem); // OpenSSL with the legacy provider loaded can read it
        } catch (PaymentException $e) {
            self::assertSame('pfx_legacy_encryption', $e->errorCode);
            self::assertStringContainsString('openssl pkcs12 -legacy', $e->getMessage());
        }
    }
}
