<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\GetPay\GetPayAdapter;
use NepalPayments\GetPay\GetPayConfig;
use NepalPayments\Http\HttpRequest;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentException;
use NepalPayments\SdkResult;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class GetPayTest extends TestCase
{
    private const BASE = 'https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions';
    private const ID = '0cc5b1a39f3c4cad864bc1c6a524534f';
    private const OPR_KEY = '4fa4c6b9-3f91-43e5-9b4f-319f68187ba5';

    private static function papInfo(): string
    {
        return base64_encode((string) json_encode(['institutionId' => '122', 'mid' => '123123451770986', 'tid' => '12358762']));
    }

    private static function secret(): string
    {
        return base64_encode(hash('sha256', self::OPR_KEY . self::ID, true));
    }

    private static function token(): string
    {
        return base64_encode((string) json_encode(['id' => self::ID, 'oprSecret' => self::secret()]));
    }

    /** @param (\Closure(HttpRequest): array{status?: int, body: mixed})|null $handler */
    private static function g(?\Closure $handler = null, ?MockTransport &$mock = null): GetPayAdapter
    {
        $cfg = new GetPayConfig(Environment::Sandbox, self::papInfo(), self::OPR_KEY, 'https://shop.example', 'Shop', 'https://shop.example/logo.png');

        return new GetPayAdapter($cfg, MockTransport::client($handler ?? static fn () => ['body' => []], $mock));
    }

    /**
     * @param array<string, mixed> $data
     * @return \Closure(): array{body: mixed}
     */
    private static function ok(array $data): \Closure
    {
        return static fn () => ['body' => ['status' => 0, 'message' => 'SUCCESS', 'data' => $data]];
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

    public function testOprSecretIsBase64Sha256OfOprKeyPlusIdTokenDecodesFromJsonOrIdColonSecret(): void
    {
        self::assertSame(self::secret(), GetPayAdapter::oprSecret(self::OPR_KEY, self::ID));
        self::assertSame(['id' => self::ID, 'oprSecret' => self::secret()], GetPayAdapter::decodeToken(self::token()));
        self::assertSame(['id' => self::ID, 'oprSecret' => self::secret()], GetPayAdapter::decodeToken(base64_encode(self::ID . ':' . self::secret())));
        self::assertNull(GetPayAdapter::decodeToken('%%%'));
        self::assertNull(GetPayAdapter::decodeToken(base64_encode((string) json_encode(['id' => self::ID]))));
    }

    public function testInitiateSdkOptionsWithANumericPriceClientRequestIdAndSameOriginCallbacks(): void
    {
        $g = self::g();
        $r = $g->initiate(new InitiateInput('P1', 120050, 'Cup <set>', 'https://shop.example/ok/P1', 'https://shop.example/no/P1'));
        self::assertInstanceOf(SdkResult::class, $r);
        self::assertSame('sdk', $r->kind);
        self::assertSame('https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js', $r->scriptUrl);
        self::assertSame(1200.5, $r->options['price']);
        self::assertSame('P1', $r->options['clientRequestId']);
        self::assertSame(self::BASE, $r->options['baseUrl']);
        self::assertSame('', $r->options['insKey']);
        self::assertSame(['successUrl' => 'https://shop.example/ok/P1', 'failUrl' => 'https://shop.example/no/P1'], $r->options['callbackUrl']);
        self::assertMatchesRegularExpression('/Cup &lt;set&gt;/', (string) $r->options['orderInformationUI']);
        self::assertSame('invalid_callback_url', self::code(static fn () => $g->initiate(new InitiateInput('P1', 100, 'x', 'https://evil.example/ok'))));
        $page = $g->checkoutPage($r, '/pay/P1</script>');
        self::assertMatchesRegularExpression('/new GetPay\(o\)\.initialize\(\)/', $page);
        self::assertTrue(!str_contains($page, '</script>"') && str_contains($page, '\u003c/script>'));
        self::assertMatchesRegularExpression('/<div id="checkout"><\/div>/', $g->paymentPage());
        self::assertMatchesRegularExpression('/window\.top\.location/', $g->returnPage('/payments/getpay/return/P1'));
    }

    public function testVerifyWithTokenOprSecretCheckedMerchantStatusClientIdMustBeThisOrder(): void
    {
        $paid = self::ok(['status' => 'SUCCESS', 'amount' => 1200.0, 'currency' => 'NPR', 'stan' => '379832', 'crrn' => '624503379832', 'clientId' => 'P1', 'remarks' => 'Success']);
        $v = self::g($paid, $mock)->verify(new VerifyInput('P1', 120000, null, ['token' => self::token()]));
        self::assertSame(['paid', 120000, self::ID], [$v->status->value, $v->amountPaisa, $v->transactionId]);
        self::assertSame(self::BASE . '/merchant-status', $mock->calls[0]->url);
        self::assertSame(['id' => self::ID, 'papInfo' => self::papInfo()], $mock->jsonBody(0));

        $other = self::g(self::ok(['status' => 'SUCCESS', 'amount' => 1200.0, 'clientId' => 'SOMEONE-ELSES-ORDER']));
        self::assertSame('id_mismatch', self::code(static fn () => $other->verify(new VerifyInput('P1', 120000, null, ['token' => self::token()]))));

        $forged = base64_encode((string) json_encode(['id' => self::ID, 'oprSecret' => base64_encode('not the hash')]));
        self::assertSame('bad_signature', self::code(static fn () => $other->verify(new VerifyInput('P1', 120000, null, ['token' => $forged]))));
        self::assertSame('malformed_callback', self::code(static fn () => $other->verify(new VerifyInput('P1', 120000, null, ['token' => '@@']))));

        $failed = self::g(self::ok(['status' => 'FAILED', 'amount' => 1200.0, 'clientId' => 'P1']));
        self::assertSame('failed', $failed->verify(new VerifyInput('P1', 120000, null, ['token' => self::token()]))->status->value);
        $missing = self::g(static fn () => ['status' => 400, 'body' => ['status' => -1, 'message' => 'Failed to fetch merchant information: Transaction not found for ID: ' . self::ID]]);
        self::assertSame('not_found', $missing->verify(new VerifyInput('P1', 120000, null, ['token' => self::token()]))->status->value);
    }

    public function testVerifyWithoutTokenStatementByClientRequestIdASuccessThereIsUnknownNeverPaid(): void
    {
        $v = self::g(self::ok(['transactionId' => self::ID, 'clientRequestId' => 'P1', 'saleTransactionAmount' => 1200.0, 'status' => 'SUCCESS', 'paymentScheme' => 'MASTERCARD']), $mock)
            ->verify(new VerifyInput('P1', 120000));
        self::assertSame(['unknown', 120000, self::ID], [$v->status->value, $v->amountPaisa, $v->transactionId]);
        self::assertSame(self::BASE . '/transaction-statement', $mock->calls[0]->url);
        self::assertSame(['clientRequestId' => 'P1'], $mock->jsonBody(0));
        $failed = self::g(self::ok(['transactionId' => self::ID, 'clientRequestId' => 'P1', 'saleTransactionAmount' => 1200.0, 'status' => 'FAILED']));
        self::assertSame('failed', $failed->verify(new VerifyInput('P1', 120000))->status->value);
        $missing = self::g(static fn () => ['status' => 400, 'body' => ['status' => -1, 'message' => 'Failed to fetch transaction statement: Transaction not found for transaction ID: x']]);
        self::assertSame('not_found', $missing->verify(new VerifyInput('P1', 120000))->status->value);
        $this->expectException(PaymentException::class);
        self::g(static fn () => ['status' => 500, 'body' => 'oops'])->verify(new VerifyInput('P1', 120000));
    }
}
