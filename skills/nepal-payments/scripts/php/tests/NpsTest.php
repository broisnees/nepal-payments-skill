<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\InitiateInput;
use NepalPayments\Nps\NpsAdapter;
use NepalPayments\Nps\NpsConfig;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class NpsTest extends TestCase
{
    /** @param array<string, mixed> $body */
    private static function n(array $body, ?MockTransport &$mock = null): NpsAdapter
    {
        return new NpsAdapter(new NpsConfig(Environment::Sandbox, '9', 'TestMerchant', 'u', 'p', 'secret'), MockTransport::client(static fn () => ['body' => $body], $mock));
    }

    public function testSignatureIsHmacSha512HexOfValuesOfSortedKeysNoSeparator(): void
    {
        $p = ['MerchantTxnId' => 'T1', 'MerchantName' => 'TestMerchant', 'Amount' => '100', 'MerchantId' => '9'];
        self::assertSame(hash_hmac('sha512', '100' . '9' . 'TestMerchant' . 'T1', 'secret'), NpsAdapter::sign('secret', $p));
        self::assertSame(hash_hmac('sha512', '9TestMerchant', 'secret'), NpsAdapter::sign('secret', ['MerchantId' => '9', 'MerchantName' => 'TestMerchant']));
    }

    public function testInitiateGetProcessIdThenMultipartFormWithMatchingAmountAndTxnId(): void
    {
        $n = self::n(['code' => '0', 'message' => 'Success', 'errors' => [], 'data' => ['ProcessId' => 'PROC_1']], $mock);
        $r = $n->initiate(new InitiateInput('T1', 10000, 'x', 'https://r'));
        self::assertSame('https://apisandbox.nepalpayment.com/GetProcessId', $mock->calls[0]->url);
        self::assertSame(NpsAdapter::sign('secret', ['MerchantId' => '9', 'MerchantName' => 'TestMerchant', 'Amount' => '100', 'MerchantTxnId' => 'T1']), $mock->jsonBody(0)['Signature']);
        self::assertSame('multipart/form-data', $r->enctype);
        self::assertSame('100', $r->fields['Amount']);
        self::assertSame('PROC_1', $r->fields['ProcessId']);
        self::assertSame('https://gatewaysandbox.nepalpayment.com/Payment/Index', $r->action);
    }

    public function testStatusCode0FailIsAFailedPaymentErrorCode3IsNotFound(): void
    {
        self::assertSame(PaymentStatus::Failed, self::n(['code' => '0', 'message' => '', 'errors' => [], 'data' => ['Status' => 'Fail', 'Amount' => '100', 'MerchantTxnId' => 'T1']])->verify(new VerifyInput('T1', 10000))->status);
        $v = self::n(['code' => '0', 'message' => '', 'errors' => [], 'data' => ['Status' => 'Success', 'Amount' => '100.00', 'MerchantTxnId' => 'T1', 'GatewayReferenceNo' => 'G1']])->verify(new VerifyInput('T1', 10000));
        self::assertSame(PaymentStatus::Paid, $v->status);
        self::assertSame(10000, $v->amountPaisa);
        self::assertSame(PaymentStatus::NotFound, self::n(['code' => '1', 'message' => '', 'errors' => [['error_code' => '3', 'error_message' => 'Transaction not initialized yet']], 'data' => null])->verify(new VerifyInput('T1', 10000))->status);
    }

    // ---- Python-only cases

    public function testPythonProviderRefIsProcessIdAndFailWithoutAmount(): void
    {
        $f = self::n(['code' => '0', 'message' => '', 'errors' => [], 'data' => ['ProcessId' => 'PROC_1']])->initiate(new InitiateInput('T1', 10000, 'x', 'https://r'));
        self::assertSame(['multipart/form-data', 'PROC_1', '100'], [$f->enctype, $f->providerRef, $f->fields['Amount']]);
        $v = self::n(['code' => '0', 'errors' => [], 'data' => ['Status' => 'Fail', 'MerchantTxnId' => 'T1']])->verify(new VerifyInput('T1', 10000));
        self::assertSame([PaymentStatus::Failed, null], [$v->status, $v->amountPaisa]);
    }

    // ---- brief behaviours not covered by the TS/Python tests

    public function testNotificationAckAndOtherErrorsThrow(): void
    {
        $n = self::n([]);
        self::assertSame('received', $n->notificationResponse(false));
        self::assertSame('already received', $n->notificationResponse(true));
        try {
            self::n(['code' => '1', 'message' => 'bad', 'errors' => [['error_code' => '5', 'error_message' => 'Invalid signature']], 'data' => null])->verify(new VerifyInput('T1', 10000));
            self::fail('expected exception');
        } catch (\NepalPayments\PaymentException $e) {
            self::assertSame('nps_5', $e->errorCode);
            self::assertSame('NPS CheckTransactionStatus: Invalid signature', $e->getMessage());
        }
    }
}
