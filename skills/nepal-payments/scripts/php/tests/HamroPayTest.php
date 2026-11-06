<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\FormResult;
use NepalPayments\HamroPay\HamroPayAdapter;
use NepalPayments\HamroPay\HamroPayConfig;
use NepalPayments\Http\HttpClient;
use NepalPayments\Http\HttpRequest;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentException;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class HamroPayTest extends TestCase
{
    private const MID = 'PN_-Nd99TBnAlBjCgl8ef_b';

    private static function config(Environment $env = Environment::Sandbox, ?string $webhookSecret = 'whsec'): HamroPayConfig
    {
        return new HamroPayConfig($env, self::MID, 'client@123', 'merchant-api-key-test', 'abcdefg', $webhookSecret);
    }

    /** @param (\Closure(HttpRequest): array{status?: int, body: mixed})|null $handler */
    private static function h(?\Closure $handler = null, ?MockTransport &$mock = null, ?HamroPayConfig $cfg = null): HamroPayAdapter
    {
        return new HamroPayAdapter($cfg ?? self::config(), MockTransport::client($handler ?? static fn () => ['body' => []], $mock));
    }

    private static function node(string $secret, string $msg): string
    {
        return base64_encode(hash_hmac('sha512', $msg, $secret, true));
    }

    /** @param \Closure(): mixed $fn */
    private static function code(\Closure $fn): string
    {
        try {
            $fn();
        } catch (PaymentException $e) {
            return $e->errorCode;
        }
        self::fail('expected PaymentException');
    }

    /** @param \Closure(): mixed $fn */
    private static function message(\Closure $fn): string
    {
        try {
            $fn();
        } catch (\Exception $e) {
            return $e->getMessage();
        }
        self::fail('expected exception');
    }

    public function testSignatureBase64HmacSha512OverCommaJoinedValuesCommasRefused(): void
    {
        self::assertSame(self::node('abcdefg', 'T1,1000,M,C,K'), HamroPayAdapter::sign('abcdefg', ['T1', '1000', 'M', 'C', 'K']));
        self::assertStringContainsString('commas', self::message(static fn () => HamroPayAdapter::sign('s', ['a,b'])));
    }

    public function testInitiateCreateSessionSignedInHeadersThenASignedGatewayForm(): void
    {
        $r = self::h(static fn () => ['body' => ['sessionId' => 'ca8f7b70-b9c9-11ee-8611-0a73743c8233', 'merchantId' => self::MID]], $mock)
            ->initiate(new InitiateInput('P1', 8992, 'T-shirt', 'https://shop.example/ok', 'https://shop.example/no'));
        self::assertSame('https://uat-payclient.hamropatro.com/v1/checkout/sessionId', $mock->calls[0]->url);
        self::assertSame('client@123', $mock->header(0, 'Client-Id'));
        self::assertSame('merchant-api-key-test', $mock->header(0, 'Client-API-Key'));
        self::assertSame('close', $mock->header(0, 'Connection'));
        self::assertSame(self::node('abcdefg', 'P1,8992,' . self::MID . ',client@123,merchant-api-key-test'), $mock->header(0, 'Signature'));
        $body = $mock->jsonBody(0);
        self::assertSame(
            ['P1', '8992', 'https://shop.example/ok', 'https://shop.example/no', 89.92],
            [$body['merchantTxnId'], $body['transactionAmount'], $body['successRedirectionUrl'], $body['failedRedirectionUrl'], $body['productList'][0]['price']],
        );
        self::assertInstanceOf(FormResult::class, $r);
        self::assertSame('form', $r->kind);
        self::assertSame('https://uat-checkout-pay.hamropatro.com/api/checkout', $r->action);
        self::assertSame('ca8f7b70-b9c9-11ee-8611-0a73743c8233', $r->providerRef);
        self::assertSame(self::node('abcdefg', self::MID . ',P1,ca8f7b70-b9c9-11ee-8611-0a73743c8233,8992,client@123,merchant-api-key-test'), $r->fields['token']);
        self::assertSame(['merchant_id', 'session_id', 'token', 'merchant_transaction_id', 'remarks'], array_keys($r->fields));
    }

    public function testInitiateRs10To50000And25CharIdLiveGatewayRequiredMerchantEchoChecked(): void
    {
        $h = self::h();
        self::assertStringContainsString('Rs 10', self::message(static fn () => $h->initiate(new InitiateInput('P1', 999, 'x', 'https://a/'))));
        self::assertStringContainsString('Rs 10', self::message(static fn () => $h->initiate(new InitiateInput('P1', 5_000_001, 'x', 'https://a/'))));
        self::assertStringContainsString('1–25', self::message(static fn () => $h->initiate(new InitiateInput(str_repeat('X', 26), 1000, 'x', 'https://a/'))));
        $live = self::h(cfg: self::config(Environment::Production));
        self::assertStringContainsString('gatewayUrl', self::message(static fn () => $live->initiate(new InitiateInput('P1', 1000, 'x', 'https://a/'))));
        $other = self::h(static fn () => ['body' => ['sessionId' => 'S', 'merchantId' => 'SOMEONE_ELSE']]);
        self::assertSame('merchant_mismatch', self::code(static fn () => $other->initiate(new InitiateInput('P1', 1000, 'x', 'https://a/'))));
        $denied = self::h(static fn () => ['status' => 401, 'body' => ['code' => 16, 'message' => 'Unauthorized Request', 'details' => []]]);
        self::assertSame('unauthorized', self::code(static fn () => $denied->initiate(new InitiateInput('P1', 1000, 'x', 'https://a/'))));
    }

    public function testVerifyGetTransactionSignedStatusMappingRupeesToPaisaIdEchoChecked(): void
    {
        $cases = [
            [['merchantTxnId' => 'P1', 'status' => 'COMPLETED', 'amount' => 89.92, 'trackingId' => 'TRK1'], 'paid', 8992],
            [['merchantTransactionId' => 'P1', 'status' => 'PROCESSING', 'amount' => 0], 'pending', null],
            [['merchantTxnId' => 'P1', 'status' => 'FAILED', 'amount' => 0], 'failed', null],
            [['merchantTransactionId' => 'P1', 'trackingId' => '', 'status' => 'NOT_INITIATED', 'amount' => 0, 'message' => 'TRANSACTION NOT INITIATED YET'], 'not_found', null],
            [['merchantTxnId' => 'P1', 'status' => 'SOMETHING_NEW'], 'unknown', null],
        ];
        foreach ($cases as [$body, $want, $amt]) {
            $v = self::h(static fn () => ['body' => $body], $mock)->verify(new VerifyInput('P1', 8992));
            self::assertSame([$want, $amt], [$v->status->value, $v->amountPaisa]);
            self::assertSame('https://uat-payclient.hamropatro.com/v1/checkout/transaction', $mock->calls[0]->url);
            self::assertSame(self::node('abcdefg', 'P1,' . self::MID . ',client@123,merchant-api-key-test'), $mock->header(0, 'Signature'));
            self::assertSame(['merchantId' => self::MID, 'merchantTxnId' => 'P1'], $mock->jsonBody(0));
        }
        $wrong = self::h(static fn () => ['body' => ['merchantTxnId' => 'P2', 'status' => 'COMPLETED', 'amount' => 89.92]]);
        self::assertSame('id_mismatch', self::code(static fn () => $wrong->verify(new VerifyInput('P1', 8992))));
        self::assertSame('P1', self::h()->orderIdFromCallback(['MerchantTxnId' => 'P1']));
    }

    public function testWebhookSignatureOverTxnMerchantStatusAmountInAnyRenderingOfTheAmount(): void
    {
        $h = self::h();
        $body = ['merchantTxnId' => 'P1', 'merchantId' => self::MID, 'amount' => 1200, 'status' => 'COMPLETED', 'metadata' => []];
        foreach (['1200', '1200.0', '1200.00'] as $a) {
            self::assertTrue($h->verifyWebhook($body, self::node('whsec', 'P1,' . self::MID . ",COMPLETED,{$a}")));
        }
        self::assertTrue($h->verifyWebhook(['amount' => 1.5] + $body, self::node('whsec', 'P1,' . self::MID . ',COMPLETED,1.50')));
        self::assertFalse($h->verifyWebhook(['amount' => 1201] + $body, self::node('whsec', 'P1,' . self::MID . ',COMPLETED,1200')));
        self::assertFalse($h->verifyWebhook(['amount' => '1200'] + $body, self::node('whsec', 'P1,' . self::MID . ',COMPLETED,1200')));
        self::assertFalse($h->verifyWebhook($body, null));
        $noSecret = self::h(cfg: self::config(webhookSecret: null));
        self::assertStringContainsString('webhookSecret', self::message(static fn () => $noSecret->verifyWebhook($body, 'x')));
    }

    /** PHP-only: JS toFixed rounds an exact binary tie up, where sprintf would round it to even. */
    public function testWebhookAmountTieRendersLikeJsToFixed(): void
    {
        $body = ['merchantTxnId' => 'P1', 'merchantId' => self::MID, 'amount' => 0.125, 'status' => 'COMPLETED'];
        self::assertTrue(self::h()->verifyWebhook($body, self::node('whsec', 'P1,' . self::MID . ',COMPLETED,0.13')));
        self::assertFalse(self::h()->verifyWebhook($body, self::node('whsec', 'P1,' . self::MID . ',COMPLETED,0.12')));
    }

    /** Runs tests/fixtures/truncated-server.php and calls verify against it with the real curl transport. */
    private static function verifyAgainstTruncated(string $chunk): string
    {
        $proc = proc_open([PHP_BINARY, __DIR__ . '/fixtures/truncated-server.php', $chunk], [1 => ['pipe', 'w']], $pipes);
        self::assertIsResource($proc);
        try {
            $port = (int) fgets($pipes[1]);
            self::assertGreaterThan(0, $port);
            $cfg = new HamroPayConfig(Environment::Sandbox, 'm', 'c', 'k', 's', apiBaseUrl: "http://127.0.0.1:{$port}", timeoutMs: 5_000);
            $h = new HamroPayAdapter($cfg, new HttpClient(sleepMs: static function (int $ms): void {
            }));
            try {
                $h->verify(new VerifyInput('O1', 1000));
            } catch (PaymentException $e) {
                return $e->errorCode . ' ' . ($e->httpStatus ?? 0);
            }
            self::fail('expected PaymentException');
        } finally {
            proc_terminate($proc);
            proc_close($proc);
        }
    }

    public function testTruncatedChunkedBodyIsKeptOnlyWhenItIsCompleteJson(): void
    {
        self::assertSame('unauthorized 401', self::verifyAgainstTruncated('{"code":16,"message":"Unauthorized Request","details":[]}'));
        self::assertSame('network_error 0', self::verifyAgainstTruncated('{"code":16,"message":"Unauth'));
    }
}
