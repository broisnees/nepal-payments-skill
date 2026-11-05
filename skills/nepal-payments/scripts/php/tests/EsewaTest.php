<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Crypto;
use NepalPayments\Esewa\EsewaAdapter;
use NepalPayments\Esewa\EsewaConfig;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Json;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class EsewaTest extends TestCase
{
    private const ORDER = ['total_amount', 'transaction_uuid', 'product_code'];

    /** @param array<string, mixed>|string $body */
    private static function adapter(array|string $body = [], int $status = 200, ?MockTransport &$mock = null): EsewaAdapter
    {
        return new EsewaAdapter(EsewaConfig::sandbox(), MockTransport::client(static fn () => ['status' => $status, 'body' => $body], $mock));
    }

    public function testSignatureTestVectors(): void
    {
        $k = EsewaConfig::SANDBOX_SECRET_KEY;
        self::assertSame('5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=', EsewaAdapter::sign($k, ['total_amount' => '100', 'transaction_uuid' => '11-201-13', 'product_code' => 'EPAYTEST'], self::ORDER));
        self::assertSame('0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=', EsewaAdapter::sign($k, ['total_amount' => '110', 'transaction_uuid' => 'ab14a8f2b02c3', 'product_code' => 'EPAYTEST'], self::ORDER));
        self::assertSame(
            'oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=',
            EsewaAdapter::sign(EsewaConfig::SANDBOX_INTENT_ACCESS_KEY, ['product_code' => 'INTENT', 'amount' => '100', 'transaction_uuid' => 'txn-20251220-001'], ['product_code', 'amount', 'transaction_uuid']),
        );
    }

    public function testInitiateAmountIsTheTotalBreakdownIncludedSameStringSignedAndPosted(): void
    {
        $e = self::adapter();
        $r = $e->initiate(new InitiateInput('ORD-1', 11050, 'x', 'https://s/r/ORD-1'), taxPaisa: 1000);
        self::assertSame('form', $r->kind);
        self::assertSame('110.50', $r->fields['total_amount']);
        self::assertSame('100.50', $r->fields['amount']);
        try {
            $e->initiate(new InitiateInput('ORD-1', 1000, 'x', 'https://s'), taxPaisa: 1000);
            self::fail('expected exception');
        } catch (PaymentException $ex) {
            self::assertStringContainsString('less than the total', $ex->getMessage());
        }
        self::assertSame(EsewaAdapter::sign(EsewaConfig::SANDBOX_SECRET_KEY, $r->fields, self::ORDER), $r->fields['signature']);
        self::assertSame('https://rc-epay.esewa.com.np/api/epay/main/v2/form', $r->action);
    }

    public function testRejectsUuidWithForbiddenCharacters(): void
    {
        $this->expectException(PaymentException::class);
        $this->expectExceptionMessage('letters, digits');
        self::adapter()->initiate(new InitiateInput('a_b', 100, 'x', 'https://s'));
    }

    /** @param array<string, string> $overrides @return array<string, string> */
    private static function successData(array $overrides = []): array
    {
        $p = array_merge([
            'transaction_code' => '000AWEO',
            'status' => 'COMPLETE',
            'total_amount' => '1000.0',
            'transaction_uuid' => 'ORD-2',
            'product_code' => 'EPAYTEST',
            'signed_field_names' => 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names',
        ], $overrides);
        $p['signature'] = EsewaAdapter::sign(EsewaConfig::SANDBOX_SECRET_KEY, $p, explode(',', $p['signed_field_names']));

        return $p;
    }

    /** @param array<string, mixed> $p */
    private static function b64(array $p): string
    {
        return Crypto::toBase64(Json::encode($p));
    }

    public function testSuccessPayloadSignatureVerifiesTamperFailsCommaVariantAccepted(): void
    {
        $e = self::adapter();
        $p = self::successData();
        $data = self::b64($p);
        self::assertTrue($e->parseSuccess($data)->signatureValid);
        self::assertTrue($e->parseSuccess(str_replace('+', ' ', $data))->signatureValid); // '+' -> ' ' in query
        self::assertFalse($e->parseSuccess(self::b64(['total_amount' => '1.0'] + $p))->signatureValid);
        // eSewa signs "1000.0" but displays "1,000.0"
        self::assertTrue($e->parseSuccess(self::b64(['total_amount' => '1,000.0'] + $p))->signatureValid);
    }

    public function testNumericTotalAmountIsVerifiedAgainstItsRawJsonText(): void
    {
        $p = self::successData(); // signed over total_amount=1000.0
        $json = str_replace('"total_amount":"1000.0"', '"total_amount":1000.0', Json::encode($p));
        self::assertStringContainsString('"total_amount":1000.0', $json);
        self::assertTrue(self::adapter()->parseSuccess(Crypto::toBase64($json))->signatureValid);
    }

    public function testVerifyStatusApiIsAuthoritativeAndUsesTheStoredTotal(): void
    {
        $e = self::adapter(['product_code' => 'EPAYTEST', 'transaction_uuid' => 'ORD-2', 'total_amount' => 1000.0, 'status' => 'COMPLETE', 'ref_id' => '0001TS9'], 200, $mock);
        $v = $e->verify(new VerifyInput('ORD-2', 100000, null, ['data' => self::b64(self::successData())]));
        self::assertSame(PaymentStatus::Paid, $v->status);
        self::assertSame(100000, $v->amountPaisa);
        self::assertSame('0001TS9', $v->transactionId);
        self::assertMatchesRegularExpression('~^https://rc\.esewa\.com\.np/api/epay/transaction/status/\?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2$~', $mock->calls[0]->url);
    }

    public function testVerifyCallbackForAnotherOrderIsRejected(): void
    {
        $this->expectException(PaymentException::class);
        $this->expectExceptionMessage('does not match');
        self::adapter()->verify(new VerifyInput('ORD-2', 100000, null, ['data' => self::b64(self::successData(['transaction_uuid' => 'OTHER']))]));
    }

    public function testStatusMapping(): void
    {
        foreach ([['PENDING', 'pending'], ['AMBIGUOUS', 'pending'], ['NOT_FOUND', 'not_found'], ['FULL_REFUND', 'refunded'], ['CANCELED', 'canceled'], ['WEIRD', 'unknown']] as [$s, $n]) {
            $e = self::adapter(['status' => $s, 'total_amount' => 10, 'ref_id' => null]);
            self::assertSame($n, $e->verify(new VerifyInput('X', 1000))->status->value);
        }
    }

    // ---- Python-only cases

    public function testPythonIntentBookSignsTheAmount(): void
    {
        $e = self::adapter(['code' => 'IP-201', 'data' => ['booking_id' => 'VkQ=', 'deeplink' => 'https://rc-links.esewa.com.np/pay/VkQ=', 'correlation_id' => 'C1']], 200, $mock);
        $b = $e->intentBook('txn-20251220-001', 10000, 'https://cb', 'https://done');
        $body = $mock->jsonBody(0);
        self::assertSame('oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=', $body['signature']);
        self::assertSame(100, $body['amount']);
        self::assertSame('VkQ=|C1', $b->providerRef);
        self::assertSame('https://rc-checkout.esewa.com.np/api/client/intent/payment/book', $mock->calls[0]->url);
    }

    public function testPythonVerifyStatusUrlAndMismatchInOneFlow(): void
    {
        $e = self::adapter(['product_code' => 'EPAYTEST', 'transaction_uuid' => 'ORD-2', 'total_amount' => 1000.0, 'status' => 'COMPLETE', 'ref_id' => 'R1'], 200, $mock);
        $v = $e->verify(new VerifyInput('ORD-2', 100000, null, ['data' => self::b64(self::successData())]));
        self::assertSame([PaymentStatus::Paid, 100000, 'R1'], [$v->status, $v->amountPaisa, $v->transactionId]);
        self::assertStringContainsString('total_amount=1000&transaction_uuid=ORD-2', $mock->calls[0]->url);
    }

    // ---- brief: callback signature enforced in strict mode; orderIdFromCallback key order

    public function testStrictModeRejectsBadCallbackSignatureLaxModeFallsThroughToStatusApi(): void
    {
        $bad = self::b64(['signature' => 'AAAA'] + self::successData());
        try {
            self::adapter()->verify(new VerifyInput('ORD-2', 100000, null, ['data' => $bad]));
            self::fail('expected invalid_signature');
        } catch (PaymentException $ex) {
            self::assertSame('invalid_signature', $ex->errorCode);
        }
        $cfg = EsewaConfig::sandbox();
        $lax = new EsewaAdapter(
            new EsewaConfig($cfg->env, $cfg->productCode, $cfg->secretKey, strictSignature: false),
            MockTransport::client(static fn () => ['body' => ['status' => 'PENDING', 'total_amount' => 1000.0, 'ref_id' => null]]),
        );
        $v = $lax->verify(new VerifyInput('ORD-2', 100000, null, ['data' => $bad]));
        self::assertSame(PaymentStatus::Pending, $v->status);
        self::assertIsArray($v->raw);
        self::assertFalse($v->raw['signatureValid']);
    }

    public function testOrderIdFromCallback(): void
    {
        $e = self::adapter();
        self::assertSame('ORD-2', $e->orderIdFromCallback(['data' => self::b64(self::successData())]));
        self::assertNull($e->orderIdFromCallback(['data' => '!!!not-base64!!!']));
        self::assertSame('A', $e->orderIdFromCallback(['orderId' => 'A', 'order_id' => 'B', 'transaction_uuid' => 'C']));
        self::assertSame('B', $e->orderIdFromCallback(['orderId' => '', 'order_id' => 'B', 'transaction_uuid' => 'C']));
        self::assertSame('C', $e->orderIdFromCallback(['transaction_uuid' => 'C']));
        self::assertNull($e->orderIdFromCallback([]));
    }
}
