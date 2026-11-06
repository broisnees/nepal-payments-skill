<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Crypto;
use NepalPayments\Environment;
use NepalPayments\Http\HttpRequest;
use NepalPayments\InitiateInput;
use NepalPayments\NepalPay\NepalPayAdapter;
use NepalPayments\NepalPay\NepalPayConfig;
use NepalPayments\PaymentException;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class NepalPayTest extends TestCase
{
    private static ?\OpenSSLAsymmetricKey $key = null;
    private static string $pem = '';

    private const GENERATED = [
        'timestamp' => '2022-05-23 04:25:26',
        'responseCode' => '000',
        'responseStatus' => 'SUCCESS',
        'responseMessage' => 'QR String generated successfully.',
        'data' => ['validationTraceId' => '2205260000001900KIY', 'qrString' => ' 000201010212...6304607F', 'qrImage' => 'iVBORw0KGgo='],
    ];

    public static function setUpBeforeClass(): void
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($key);
        self::$key = $key;
        openssl_pkey_export($key, $pem);
        self::$pem = (string) $pem;
    }

    private static function config(string $auth = 'basic', ?string $clientId = null, ?string $clientSecret = null): NepalPayConfig
    {
        return new NepalPayConfig(
            Environment::Sandbox,
            '00001701',
            '17012UVSTIR',
            'BBSM',
            5021,
            'Kathmandu',
            '4600',
            'Store1',
            'npiuser',
            'pw',
            self::$pem,
            terminalLabel: 'Terminal1',
            auth: $auth,
            clientId: $clientId,
            clientSecret: $clientSecret,
        );
    }

    /** @param \Closure(HttpRequest): array{status?: int, body: mixed} $handler */
    private static function adapter(\Closure $handler, ?MockTransport &$mock = null, ?NepalPayConfig $cfg = null): NepalPayAdapter
    {
        return new NepalPayAdapter($cfg ?? self::config(), MockTransport::client($handler, $mock));
    }

    private static function verifySig(string $sig, string $msg): bool
    {
        \assert(self::$key !== null);
        $pub = openssl_pkey_get_public((string) openssl_pkey_get_details(self::$key)['key']);
        self::assertNotFalse($pub);

        return openssl_verify($msg, Crypto::fromBase64($sig), $pub, OPENSSL_ALGO_SHA256) === 1;
    }

    /** @param array<string, mixed> $o @return array<string, mixed> */
    private static function txn(array $o): array
    {
        return array_merge(['nQrTxnId' => '2312060000059575KMB', 'amount' => 10.5, 'tranType' => 'PMT', 'merchantBillNo' => 'P1'], $o);
    }

    /** @param list<mixed> $rows @return array<string, mixed> */
    private static function report(array $rows): array
    {
        return ['timestamp' => '2024-02-07T07:10:47.928+0000', 'responseCode' => '200', 'responseStatus' => 'SUCCESS', 'responseBody' => $rows];
    }

    public function testTokenStringCommaJoinedNoSpacesUserIdLast(): void
    {
        self::assertSame(
            '00001701,17012UVSTIR,5021,524,10.50,P1,npiuser',
            NepalPayAdapter::tokenString([
                'acquirerId' => '00001701', 'merchantId' => '17012UVSTIR', 'merchantCategoryCode' => 5021, 'transactionCurrency' => 524,
                'transactionAmount' => '10.50', 'billNumber' => 'P1', 'userId' => 'npiuser',
            ]),
        );
    }

    public function testInitiateDynamicQrRupeesWith2DecimalsSignedTokenBasicAuthQrResult(): void
    {
        $n = self::adapter(static fn () => ['body' => self::GENERATED], $mock);
        $r = $n->initiate(new InitiateInput('P1', 1050, 'Everest T-shirt, large and blue', ''));
        self::assertSame('https://devopennpi.connectips.com/qr/generateQR', $mock->calls[0]->url);
        self::assertSame('Basic ' . base64_encode('npiuser:pw'), $mock->header(0, 'Authorization'));
        $body = $mock->jsonBody(0);
        self::assertSame(12, $body['pointOfInitialization']);
        self::assertSame('10.50', $body['transactionAmount']);
        self::assertSame(524, $body['transactionCurrency']);
        self::assertSame('P1', $body['billNumber']);
        self::assertSame(25, strlen((string) $body['purposeOfTransaction']));
        self::assertTrue($body['qrImage']);
        self::assertTrue(self::verifySig((string) $body['token'], '00001701,17012UVSTIR,5021,524,10.50,P1,npiuser'));
        self::assertSame(
            ['kind' => 'qr', 'providerRef' => '2205260000001900KIY', 'qrString' => '000201010212...6304607F', 'qrImage' => 'iVBORw0KGgo='],
            ['kind' => $r->kind, 'providerRef' => $r->providerRef, 'qrString' => $r->qrString, 'qrImage' => $r->qrImage],
        );

        $n = self::adapter(static fn () => ['body' => self::GENERATED], $mock);
        $n->initiate(new InitiateInput('P2', 100000, 'x', ''));
        self::assertSame('1000.00', $mock->jsonBody(0)['transactionAmount']);
    }

    public function testInitiateBillNumberCharsetLengthAndErrorCodesSurface(): void
    {
        try {
            self::adapter(static fn () => ['body' => self::GENERATED])->initiate(new InitiateInput(str_repeat('X', 26), 100, 'x', ''));
            self::fail('expected PaymentException');
        } catch (PaymentException $e) {
            self::assertStringContainsString('1–25', $e->getMessage());
        }
        try {
            self::adapter(static fn () => ['status' => 400, 'body' => ['responses' => [['responseCode' => 'E003', 'responseMessage' => 'INVALID TOKEN']]]])
                ->initiate(new InitiateInput('P1', 100, 'x', ''));
            self::fail('expected PaymentException');
        } catch (PaymentException $e) {
            self::assertSame('E003', $e->errorCode);
        }
    }

    public function testVerifyReportByValidationTraceIdASuccessAfterAFailedScanCounts(): void
    {
        $n = self::adapter(static fn () => ['body' => self::report([
            self::txn(['nQrTxnId' => 'A', 'debitStatus' => 'E001', 'creditStatus' => null]),
            self::txn(['nQrTxnId' => 'B', 'debitStatus' => '000', 'creditStatus' => 'DEFER']),
        ])], $mock);
        $v = $n->verify(new VerifyInput('P1', 1050, '2205260000001900KIY'));
        self::assertSame('https://devopennpi.connectips.com/nQR/v1/merchanttxnreport', $mock->calls[0]->url);
        self::assertSame(['validationTraceId' => '2205260000001900KIY', 'merchantId' => '17012UVSTIR', 'acquirerId' => '00001701'], $mock->jsonBody(0));
        self::assertSame(['paid', 1050, 'B'], [$v->status->value, $v->amountPaisa, $v->transactionId]);
    }

    public function testVerifyStatusMapping(): void
    {
        $cases = [
            [self::report([self::txn(['debitStatus' => '000', 'creditStatus' => '000'])]), 'paid'],
            [self::report([self::txn(['debitStatus' => '000', 'creditStatus' => '999'])]), 'paid'],
            [self::report([self::txn(['debitStatus' => '000', 'creditStatus' => 'E99'])]), 'unknown'],
            [self::report([self::txn(['debitStatus' => 'E001', 'creditStatus' => null])]), 'failed'],
            [self::report([self::txn(['debitStatus' => '000', 'creditStatus' => '000', 'tranType' => 'RFND'])]), 'not_found'],
            [self::report([]), 'not_found'],
            [['responseCode' => 'E010', 'responseMessage' => 'RECORD NOT FOUND'], 'not_found'],
        ];
        foreach ($cases as [$body, $want]) {
            $n = self::adapter(static fn () => ['body' => $body]);
            self::assertSame($want, $n->verify(new VerifyInput('P1', 1050, 'T'))->status->value);
        }
        try {
            self::adapter(static fn () => ['body' => self::report([])])->verify(new VerifyInput('P1', 1050));
            self::fail('expected PaymentException');
        } catch (PaymentException $e) {
            self::assertSame('missing_provider_ref', $e->errorCode);
        }
    }

    public function testOauthPasswordGrantOnceBearerReusedUntilExpiry(): void
    {
        $o = self::adapter(
            static fn (HttpRequest $r) => str_ends_with($r->url, '/oauth/token')
                ? ['body' => ['access_token' => 'AT1', 'token_type' => 'bearer', 'expires_in' => 299]]
                : ['body' => self::report([])],
            $mock,
            self::config('oauth', 'cid', 'csec'),
        );
        $o->verify(new VerifyInput('P1', 100, 'T'));
        $o->verify(new VerifyInput('P1', 100, 'T'));
        self::assertCount(3, $mock->calls);
        self::assertSame('Basic ' . base64_encode('cid:csec'), $mock->header(0, 'Authorization'));
        self::assertSame('grant_type=password&username=npiuser&password=pw', $mock->calls[0]->body);
        self::assertSame('Bearer AT1', $mock->header(1, 'Authorization'));
        self::assertSame('Bearer AT1', $mock->header(2, 'Authorization'));
    }

    public function testConfirmPaymentReplyIsSignedOverTxnDateStatusMessageMerchantBillNoPaymentRef(): void
    {
        $n = self::adapter(static fn () => ['body' => []]);
        $r = $n->confirmationResponse('2024-11-10 01:35:31', 'P1', '2411100000067378ZHU');
        self::assertTrue(self::verifySig($r['signature'], '2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU'));
        self::assertSame('P1', $n->orderIdFromCallback(['merchantBillNo' => 'P1']));
    }

    private static function withNchl(): NepalPayAdapter
    {
        \assert(self::$key !== null);
        $c = self::config();

        return self::adapter(static fn () => ['body' => []], cfg: new NepalPayConfig(
            $c->env, $c->acquirerId, $c->merchantId, $c->merchantName, $c->merchantCategoryCode, $c->merchantCity,
            $c->merchantPostalCode, $c->storeLabel, $c->username, $c->password, $c->privateKeyPem,
            terminalLabel: $c->terminalLabel,
            nchlPublicKeyPem: (string) openssl_pkey_get_details(self::$key)['key'],
            wsUrl: 'wss://ws.example/nqrws',
            wsUsername: 'wsuser',
            wsApiToken: 'secret-api-token',
        ));
    }

    public function testConfirmPaymentNotificationSignatureOverTheDocumentedStringPayerMobileFallback(): void
    {
        \assert(self::$key !== null);
        $note = [
            'merchantBillNo' => 'NA', 'merchantId' => '0010SVQNL9H', 'merchantName' => 'Quantum Labs', 'paymentRef' => '2411100000067378ZHU',
            'channel' => 'CIPS', 'payerMobile' => '+977-9843705813', 'sessionNo' => '5446', 'status' => 'SUCCESS',
        ];
        $msg = 'NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446';
        self::assertSame($msg, NepalPayAdapter::confirmationString($note));
        self::assertSame('NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,9800000000,', NepalPayAdapter::confirmationString(
            array_merge($note, ['payerMobileNumber' => '9800000000', 'sessionNo' => null]),
        ));
        openssl_sign($msg, $raw, self::$key, OPENSSL_ALGO_SHA256);
        $sig = base64_encode((string) $raw);
        $w = self::withNchl();
        self::assertTrue($w->verifyConfirmation([...$note, 'signature' => $sig]));
        self::assertFalse($w->verifyConfirmation([...$note, 'sessionNo' => '5447', 'signature' => $sig]));
        self::assertFalse($w->verifyConfirmation([...$note, 'signature' => 'not base64!']));
        self::assertFalse($w->verifyConfirmation($note));
        self::assertFalse(Crypto::rsaSha256VerifyBase64('not a pem', $msg, $sig));
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessageMatches('/nchlPublicKeyPem/');
        self::adapter(static fn () => ['body' => []])->verifyConfirmation($note);
    }

    public function testWebSocketRequestDestinationsTerminalAsMerchantIdApiTokenRsaPkcs1V15Encrypted(): void
    {
        \assert(self::$key !== null);
        $w = self::withNchl()->webSocketRequest('2205260000001900KIY');
        $token = $w['body']['api_token'];
        unset($w['body']['api_token']);
        self::assertSame([
            'url' => 'wss://ws.example/nqrws',
            'subscribe' => '/user/nqrws/check-txn-status',
            'send' => '/nqrws/check-txn-status',
            'body' => ['merchant_id' => 'Terminal1', 'request_id' => '2205260000001900KIY', 'username' => 'wsuser'],
        ], $w);
        $ct = Crypto::fromBase64($token);
        self::assertSame(256, strlen($ct));
        self::assertTrue(openssl_private_decrypt($ct, $plain, self::$key, OPENSSL_PKCS1_PADDING));
        self::assertSame('secret-api-token', $plain);
        self::assertNotSame(
            self::withNchl()->webSocketRequest('X')['body']['api_token'],
            self::withNchl()->webSocketRequest('X')['body']['api_token'],
        );
        $pub = (string) openssl_pkey_get_details(self::$key)['key'];
        try {
            Crypto::rsaPkcs1EncryptBase64($pub, str_repeat('x', 246));
            self::fail('expected too long');
        } catch (\InvalidArgumentException $e) {
            self::assertStringContainsString('too long', $e->getMessage());
        }
        self::assertNotSame('', Crypto::rsaPkcs1EncryptBase64($pub, str_repeat('x', 245)));
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessageMatches('/wsUrl/');
        self::adapter(static fn () => ['body' => []])->webSocketRequest('X');
    }
}
