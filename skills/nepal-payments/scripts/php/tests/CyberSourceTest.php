<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\CyberSource\BillTo;
use NepalPayments\CyberSource\CyberSourceAdapter;
use NepalPayments\CyberSource\CyberSourceConfig;
use NepalPayments\Environment;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class CyberSourceTest extends TestCase
{
    private static function cs(): CyberSourceAdapter
    {
        return new CyberSourceAdapter(new CyberSourceConfig(Environment::Sandbox, 'P', 'A', 'S'));
    }

    /** @param array<string, string> $o @return array<string, string> */
    private static function response(array $o): array
    {
        $p = array_merge(['req_reference_number' => 'ORD-1', 'req_currency' => 'NPR', 'req_transaction_type' => 'sale', 'transaction_id' => '7000'], $o);
        $p['signed_field_names'] = implode(',', [...array_keys($p), 'signed_field_names']);
        $p['signature'] = CyberSourceAdapter::sign('S', $p);

        return $p;
    }

    /** @param array<string, string> $cb */
    private static function verify(array $cb, string $orderId = 'ORD-1'): \NepalPayments\VerifyResult
    {
        return self::cs()->verify(new VerifyInput($orderId, 150000, null, $cb));
    }

    public function testSecureAcceptanceSignatureWorkedExample(): void
    {
        $f = [
            'access_key' => 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
            'profile_id' => 'PROFILE-0001',
            'transaction_uuid' => '7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f',
            'signed_field_names' => 'access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency',
            'unsigned_field_names' => '',
            'signed_date_time' => '2026-11-04T10:15:30Z',
            'locale' => 'en-us',
            'transaction_type' => 'sale',
            'reference_number' => 'ORDER-1001',
            'amount' => '1500.00',
            'currency' => 'NPR',
        ];
        self::assertSame('QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=', CyberSourceAdapter::sign('test_secret_key_do_not_use', $f));
    }

    public function testDecisionsMapCorrectlyUnsignedExtraFieldsIgnoredTamperRejected(): void
    {
        self::assertSame(PaymentStatus::Paid, self::verify(self::response(['decision' => 'ACCEPT', 'reason_code' => '100', 'auth_amount' => '1500.00']))->status);
        self::assertSame(PaymentStatus::Failed, self::verify(self::response(['decision' => 'DECLINE', 'reason_code' => '203']))->status);
        self::assertSame(PaymentStatus::Pending, self::verify(self::response(['decision' => 'REVIEW', 'reason_code' => '200']))->status);
        self::assertSame(PaymentStatus::Canceled, self::verify(self::response(['decision' => 'CANCEL', 'reason_code' => '']))->status);
        $ok = self::response(['decision' => 'ACCEPT', 'reason_code' => '100', 'auth_amount' => '1500.00']);
        $v = self::verify($ok + ['injected' => 'x']);
        self::assertIsArray($v->raw);
        self::assertArrayNotHasKey('injected', $v->raw);
        try {
            self::verify(['auth_amount' => '1.00'] + $ok);
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertStringContainsString('invalid response signature', $e->getMessage());
        }
        try {
            self::verify($ok, 'ORD-2');
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertStringContainsString('different order', $e->getMessage());
        }
        // signed-but-empty auth_amount falls back to req_amount (same as Python)
        $empty = self::response(['decision' => 'ACCEPT', 'reason_code' => '100', 'auth_amount' => '', 'req_amount' => '1500.00']);
        self::assertSame(150000, self::verify($empty)->amountPaisa);
    }

    public function testInitiateSignsEveryFieldInclBillToAndSendsUnsignedFieldNamesEmpty(): void
    {
        $r = self::cs()->initiate(
            new InitiateInput('ORD-1', 150000, 'x', 'https://r'),
            new BillTo('Ram', 'Sharma', 'r@e.com', 'Thamel', 'Kathmandu', 'NP'),
        );
        self::assertSame('1500.00', $r->fields['amount']);
        self::assertSame('', $r->fields['unsigned_field_names']);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $r->fields['signed_date_time']);
        self::assertStringContainsString('bill_to_address_country', $r->fields['signed_field_names']);
        self::assertSame(CyberSourceAdapter::sign('S', $r->fields), $r->fields['signature']);
    }

    // ---- brief behaviours not covered by the TS/Python tests

    public function testSignedFieldNamesOrderAndSystemErrorReasons(): void
    {
        $r = self::cs()->initiate(new InitiateInput('ORD-1', 150000, 'x', 'https://r'), new BillTo('Ram', 'Sharma', 'r@e.com', 'Thamel', 'Kathmandu', 'NP'), [2 => 'b', 1 => 'a']);
        $names = explode(',', $r->fields['signed_field_names']);
        self::assertSame(['merchant_defined_data1', 'merchant_defined_data2', 'unsigned_field_names', 'signed_field_names'], array_slice($names, -4));
        self::assertSame('access_key', $names[0]);
        self::assertSame(PaymentStatus::Unknown, self::verify(self::response(['decision' => 'ERROR', 'reason_code' => '151']))->status);
        try {
            self::cs()->verify(new VerifyInput('ORD-1', 150000));
            self::fail('expected exception');
        } catch (PaymentException $e) {
            self::assertSame('verify_unavailable', $e->errorCode);
        }
    }
}
