<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\ConnectIps\ConnectIpsAdapter;
use NepalPayments\ConnectIps\ConnectIpsConfig;
use NepalPayments\Crypto;
use NepalPayments\CyberSource\CyberSourceAdapter;
use NepalPayments\CyberSource\CyberSourceConfig;
use NepalPayments\Environment;
use NepalPayments\Esewa\EsewaAdapter;
use NepalPayments\Esewa\EsewaConfig;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Json;
use NepalPayments\Money;
use NepalPayments\Nps\NpsAdapter;
use NepalPayments\Nps\NpsConfig;
use NepalPayments\PaymentException;
use NepalPayments\Payments;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

/** TODO.md correctness list; mirrors the regression tests in scripts/ts/test/ (spread across core/ and providers/). */
final class RegressionsTest extends TestCase
{
    /** @param array<string, mixed>|string $body */
    private static function esewa(array|string $body = [], int $status = 200): EsewaAdapter
    {
        return new EsewaAdapter(EsewaConfig::sandbox(), MockTransport::client(static fn () => ['status' => $status, 'body' => $body]));
    }

    private static function expectPaymentError(\Closure $fn, string $code, ?int $httpStatus, ?string $message = null): void
    {
        try {
            $fn();
            self::fail("expected PaymentException {$code}");
        } catch (PaymentException $e) {
            self::assertSame([$code, $httpStatus], [$e->errorCode, $e->httpStatus]);
            if ($message !== null) {
                self::assertStringContainsString($message, $e->getMessage());
            }
        }
    }

    public function testPaisaToRupeesKeepsTheSignBelowOneRupee(): void
    {
        self::assertSame(['-0.05', '-0.99', '-1', '-123.45'], array_map(Money::paisaToRupees(...), [-5, -99, -100, -12345]));
    }

    public function testRupeesToPaisaRejectsExponentAndExplicitPlusForms(): void
    {
        foreach (['1e3', '+5', 'NaN', ''] as $bad) {
            try {
                Money::rupeesToPaisa($bad);
                self::fail("accepted {$bad}");
            } catch (\InvalidArgumentException $e) {
                self::assertStringContainsString('not a rupee amount', $e->getMessage());
            }
        }
    }

    public function testBasicAuthEncodesUtf8Credentials(): void
    {
        self::assertSame('Basic ' . base64_encode('ü:पासवर्ड'), Crypto::basicAuth('ü', 'पासवर्ड'));
    }

    public function testNewOrderIdUsesOnlyThe36SymbolAlphabet(): void
    {
        for ($i = 0; $i < 200; $i++) {
            self::assertMatchesRegularExpression('/^P[0-9A-Z]{18,19}$/', Payments::newOrderId());
        }
    }

    public function testProviderLookupIgnoresPrototypeKeys(): void
    {
        $p = Payments::create(Payments::configFromEnv(['ESEWA_PRODUCT_CODE' => 'EPAYTEST', 'ESEWA_SECRET_KEY' => 'k']), new MockTransport(static fn () => ['body' => []]));
        foreach (['constructor', '__proto__', 'toString'] as $id) {
            try {
                $p->adapter($id);
                self::fail("resolved {$id}");
            } catch (\LogicException $e) {
                self::assertStringContainsString('not configured', $e->getMessage());
            }
        }
        self::assertSame(ProviderId::Esewa, $p->adapter('esewa')->id());
    }

    public function testStatusTablesIgnorePrototypeKeys(): void
    {
        foreach (['constructor', '__proto__', 'toString'] as $s) {
            $v = self::esewa(['status' => $s, 'total_amount' => 10, 'ref_id' => null])->verify(new VerifyInput('X', 1000));
            self::assertSame(PaymentStatus::Unknown, $v->status);
        }
    }

    public function testEsewaMalformedSuccessDataIs400(): void
    {
        $e = self::esewa();
        foreach (['!!!!', base64_encode('not json'), base64_encode('{'), base64_encode("\xff\xfe")] as $data) {
            self::expectPaymentError(static fn () => $e->parseSuccess($data), 'malformed_callback', 400);
            self::expectPaymentError(static fn () => $e->verify(new VerifyInput('X', 1000, null, ['data' => $data])), 'malformed_callback', 400);
        }
    }

    public function testEsewaErrorBodyReadFromErrorMessageOrCamelCase(): void
    {
        self::expectPaymentError(
            static fn () => self::esewa(['code' => 0, 'errorMessage' => 'Service is currently unavailable'], 503)->verify(new VerifyInput('X', 1000)),
            'esewa_0',
            503,
            'Service is currently unavailable',
        );
        self::expectPaymentError(
            static fn () => self::esewa(['code' => 'IP-400', 'error_message' => 'Invalid Signature'], 400)->intentBook('X', 10000, 'https://c', 'https://r'),
            'esewa_IP-400',
            400,
            'Invalid Signature',
        );
        self::expectPaymentError(static fn () => self::esewa('<html>bad gateway</html>', 502)->verify(new VerifyInput('X', 1000)), 'http_502', 502);
    }

    public function testEsewaOrderIdFromCallbackKeyOrder(): void
    {
        self::assertSame('A', self::esewa()->orderIdFromCallback(['orderId' => 'A', 'order_id' => 'B']));
    }

    public function testEsewaIntentCallbackRawBodyKeepsNumberTextDecodedUsesString(): void
    {
        $e = self::esewa();
        $key = EsewaConfig::SANDBOX_INTENT_ACCESS_KEY;
        $order = ['product_code', 'amount', 'reference_code', 'status'];
        $names = implode(',', $order);
        $base = ['product_code' => 'INTENT', 'reference_code' => 'R1', 'status' => 'SUCCESS'];
        // Signed over "100.0", exactly as the JSON text carries it.
        $sigExact = EsewaAdapter::sign($key, $base + ['amount' => '100.0'], $order);
        $raw = '{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS","signed_field_names":"' . $names . '","signature":"' . $sigExact . '"}';
        self::assertTrue($e->intentCallbackValid($raw));
        self::assertFalse($e->intentCallbackValid(Json::decode($raw))); // decoded: 100.0 is just 100
        // Signed over "100", the String(v) form; the raw body is accepted too.
        $sigJs = EsewaAdapter::sign($key, $base + ['amount' => '100'], $order);
        $raw2 = str_replace($sigExact, $sigJs, $raw);
        self::assertTrue($e->intentCallbackValid($raw2));
        self::assertTrue($e->intentCallbackValid(Json::decode($raw2)));
        // null signs as "", tamper and junk fail.
        $sigNull = EsewaAdapter::sign($key, $base + ['amount' => ''], $order);
        self::assertTrue($e->intentCallbackValid($base + ['amount' => null, 'signed_field_names' => $names, 'signature' => $sigNull]));
        self::assertFalse($e->intentCallbackValid(str_replace('100.0', '1.0', $raw)));
        self::assertFalse($e->intentCallbackValid('not json'));
        self::assertFalse($e->intentCallbackValid('[1]'));
    }

    public function testNpsCode0WithNullDataIsUnknown(): void
    {
        $n = new NpsAdapter(
            new NpsConfig(Environment::Sandbox, '9', 'M', 'u', 'p', 's'),
            MockTransport::client(static fn () => ['body' => ['code' => '0', 'message' => '', 'errors' => [], 'data' => null]]),
        );
        $v = $n->verify(new VerifyInput('T1', 10000));
        self::assertSame(PaymentStatus::Unknown, $v->status);
        self::assertNull($v->amountPaisa);
    }

    public function testConnectIpsNullTxnAmtIsNullAndEmptyReferenceIdAndRemarksFallBack(): void
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        self::assertNotFalse($key);
        openssl_pkey_export($key, $pem);
        $c = new ConnectIpsAdapter(
            new ConnectIpsConfig(Environment::Sandbox, 550, 'A', 'T', 'pw', (string) $pem),
            MockTransport::client(static fn () => ['body' => ['status' => 'ERROR', 'statusDesc' => 'TRANSACTION NOT FOUND', 'txnAmt' => null]]),
        );
        self::assertNull($c->verify(new VerifyInput('T1', 500))->amountPaisa);
        $r = $c->initiate(new InitiateInput('T1', 500, 'Shoes', ''), referenceId: '', remarks: '');
        self::assertSame('T1', $r->fields['REFERENCEID']);
        self::assertSame('Shoes', $r->fields['REMARKS']);
    }

    public function testCyberSourceEmptyReferenceNumberFallsBackToTransactionUuid(): void
    {
        $cs = new CyberSourceAdapter(new CyberSourceConfig(Environment::Sandbox, 'p', 'a', 's'));
        $p = ['decision' => 'ACCEPT', 'reason_code' => '100', 'req_reference_number' => '', 'req_transaction_uuid' => 'T1', 'req_amount' => '10.00', 'req_currency' => 'NPR', 'transaction_id' => 'X1'];
        $p['signed_field_names'] = implode(',', [...array_keys($p), 'signed_field_names']);
        $p['signature'] = CyberSourceAdapter::sign('s', $p);
        self::assertSame(PaymentStatus::Paid, $cs->verify(new VerifyInput('T1', 1000, null, $p))->status);
    }
}
