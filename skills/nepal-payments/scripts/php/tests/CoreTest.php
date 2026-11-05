<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\AttemptStatus;
use NepalPayments\Crypto;
use NepalPayments\FormResult;
use NepalPayments\Html;
use NepalPayments\Money;
use NepalPayments\Payments;
use NepalPayments\PaymentStatus;
use NepalPayments\StateMachine;
use NepalPayments\TransitionDecision;
use PHPUnit\Framework\TestCase;

final class CoreTest extends TestCase
{
    // ---- TS: core

    public function testMoneyConversionsAreExact(): void
    {
        self::assertSame('100', Money::paisaToRupees(10000));
        self::assertSame('100.50', Money::paisaToRupees(10050));
        self::assertSame('0.05', Money::paisaToRupees(5));
        self::assertSame(100000, Money::rupeesToPaisa('1,000.0'));
        self::assertSame(10010, Money::rupeesToPaisa(100.1));
        self::assertSame(10, Money::rupeesToPaisa('0.1'));
        self::assertSame(2000, Money::rupeesToPaisa('19.995'));
        self::assertSame(101, Money::rupeesToPaisa(1.005)); // same as Python Decimal(str(x)); toFixed(2) would give 100
    }

    public function testDecideTransitionStateMachine(): void
    {
        $h = 60 * 60_000;
        $paid = [PaymentStatus::Paid, 1000];
        self::assertSame(AttemptStatus::Paid, StateMachine::decideTransition(AttemptStatus::Initiated, ...[...$paid, 1000, 0])->next);
        // amount guard: mismatch and missing amount both go to review, never paid
        self::assertEquals(
            new TransitionDecision(AttemptStatus::Unknown, true, false, 'amount mismatch: stored 1000, provider 10'),
            StateMachine::decideTransition(AttemptStatus::Pending, PaymentStatus::Paid, 10, 1000, 0),
        );
        self::assertTrue(StateMachine::decideTransition(AttemptStatus::Pending, PaymentStatus::Paid, null, 1000, 0)->reviewRequired);
        // not_found keeps the attempt open inside the window, expires after
        self::assertNull(StateMachine::decideTransition(AttemptStatus::Initiated, PaymentStatus::NotFound, null, 1000, 5 * 60_000)->next);
        self::assertSame(AttemptStatus::Expired, StateMachine::decideTransition(AttemptStatus::Initiated, PaymentStatus::NotFound, null, 1000, 2 * $h)->next);
        // late payment after we closed it is recovered, not dropped
        $late = StateMachine::decideTransition(AttemptStatus::Expired, ...[...$paid, 1000, 3 * $h]);
        self::assertSame(AttemptStatus::Paid, $late->next);
        self::assertTrue($late->latePaid);
        // paid is terminal for automation; same status is a no-op
        self::assertNull(StateMachine::decideTransition(AttemptStatus::Paid, PaymentStatus::Failed, null, 1000, 0)->next);
        self::assertNull(StateMachine::decideTransition(AttemptStatus::Pending, PaymentStatus::Pending, null, 1000, 0)->next);
        self::assertNull(StateMachine::decideTransition(AttemptStatus::Failed, PaymentStatus::Canceled, null, 1000, 0)->next);
    }

    public function testBase64ToleratesPlusTurnedIntoSpace(): void
    {
        $b = Crypto::toBase64("\xFB\xFF\xBE");
        self::assertSame('+/++', $b);
        self::assertSame("\xFB\xFF\xBE", Crypto::fromBase64(str_replace('+', ' ', $b)));
    }

    public function testNewOrderIdFitsEveryProvider(): void
    {
        for ($i = 0; $i < 1000; $i++) {
            self::assertMatchesRegularExpression('/^[A-Z0-9]{17,20}$/', Payments::newOrderId());
        }
    }

    public function testAutoSubmitFormEscapesValues(): void
    {
        $html = Html::renderAutoSubmitForm(new FormResult('https://x/pay', ['a' => '"><script>']));
        self::assertStringContainsString('&quot;&gt;&lt;script&gt;', $html);
    }

    // ---- Python-only cases

    public function testPythonFormEscapeWithMultipartEnctype(): void
    {
        $html = (new FormResult('https://x', ['a' => '"><script>'], 'POST', 'multipart/form-data'))->render();
        self::assertStringContainsString('&quot;&gt;&lt;script&gt;', $html);
        self::assertStringContainsString('enctype="multipart/form-data"', $html);
    }

    public function testPythonBase64SpaceRestoreAtTheEdges(): void
    {
        self::assertSame("\xFB\xFF\xBE", Crypto::fromBase64(' /  ')); // "+/++" after '+' -> ' '
    }

    public function testDecideForUsesTheVerifyResult(): void
    {
        $r = new \NepalPayments\VerifyResult(\NepalPayments\ProviderId::Khalti, PaymentStatus::Paid, 'O', 1000, 'T', null);
        self::assertSame(AttemptStatus::Paid, StateMachine::decideFor(AttemptStatus::Initiated, $r, 1000, 0)->next);
        self::assertSame([AttemptStatus::Initiated, AttemptStatus::Pending, AttemptStatus::Unknown], StateMachine::OPEN_STATUSES);
    }
}
