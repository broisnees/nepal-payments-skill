<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\ImePay\ImePayAdapter;
use NepalPayments\ImePay\ImePayConfig;
use NepalPayments\InitiateInput;
use NepalPayments\PaymentStatus;
use NepalPayments\VerifyInput;
use PHPUnit\Framework\TestCase;

final class ImePayTest extends TestCase
{
    /** @param array<string, mixed> $body */
    private static function i(array $body, ?MockTransport &$mock = null): ImePayAdapter
    {
        return new ImePayAdapter(new ImePayConfig(Environment::Sandbox, 'MC', 'u', 'p', 'MOD'), MockTransport::client(static fn () => ['body' => $body], $mock));
    }

    public function testGetTokenAndCheckoutPayloadFormat(): void
    {
        $r = self::i(['TokenId' => 'TK1', 'ResponseCode' => 0], $mock)->initiate(new InitiateInput('R1', 10000, 'x', 'https://s/ok', 'https://s/no'));
        self::assertSame('https://stg.imepay.com.np:7979/api/Web/GetToken', $mock->calls[0]->url);
        self::assertSame(base64_encode('MOD'), $mock->header(0, 'Module'));
        self::assertSame(['MerchantCode' => 'MC', 'Amount' => '100.00', 'RefId' => 'R1'], $mock->jsonBody(0));
        parse_str((string) parse_url($r->url, PHP_URL_QUERY), $q);
        self::assertSame('TK1|MC|R1|100.00|POST|https://s/ok|https://s/no', base64_decode((string) $q['data'], true));
    }

    public function testRecheck0IsPaidAnythingElseStaysPending(): void
    {
        self::assertSame(PaymentStatus::Paid, self::i(['ResponseCode' => 0, 'RefId' => 'R1', 'TranAmount' => '100.00', 'TransactionId' => 'X9'])->verify(new VerifyInput('R1', 10000, 'TK1'))->status);
        self::assertSame(PaymentStatus::Pending, self::i(['ResponseCode' => 1, 'RefId' => 'R1'])->verify(new VerifyInput('R1', 10000, 'TK1'))->status);
        self::assertNull(self::i(['ResponseCode' => 0, 'RefId' => 'R1', 'TranAmount' => ''])->verify(new VerifyInput('R1', 10000, 'TK1'))->amountPaisa); // -> review, no throw
    }
}
