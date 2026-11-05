<?php

declare(strict_types=1);

namespace NepalPayments\Tests;

use NepalPayments\Environment;
use NepalPayments\Payments;
use NepalPayments\ProviderId;
use PHPUnit\Framework\TestCase;

/** createPayments / paymentsConfigFromEnv (brief: same env var names as TS). */
final class PaymentsTest extends TestCase
{
    public function testConfigFromEnvEnablesProvidersWithRequiredVars(): void
    {
        $cfg = Payments::configFromEnv([
            'ESEWA_PRODUCT_CODE' => 'EPAYTEST', 'ESEWA_SECRET_KEY' => '8gBm/:&EnhH.1/q', 'ESEWA_ENV' => 'live',
            'ESEWA_INTENT_PRODUCT_CODE' => 'INTENT', 'ESEWA_INTENT_ACCESS_KEY' => 'K',
            'KHALTI_SECRET_KEY' => 'k', // no KHALTI_WEBSITE_URL -> disabled
            'FONEPAY_MERCHANT_CODE' => 'NBQM', 'FONEPAY_SECRET_KEY' => 's',
            'CONNECTIPS_MERCHANT_ID' => '550', 'CONNECTIPS_APP_ID' => 'A', 'CONNECTIPS_PRIVATE_KEY_PEM' => 'line1\nline2',
            'CYBERSOURCE_PROFILE_ID' => 'P', 'CYBERSOURCE_ACCESS_KEY' => 'A', 'CYBERSOURCE_SECRET_KEY' => 'S',
            'NPS_MERCHANT_ID' => '9', 'NPS_SECRET_KEY' => 's',
            'IMEPAY_MERCHANT_CODE' => 'MC', 'IMEPAY_USERNAME' => '',
        ]);
        self::assertSame(Environment::Production, $cfg->esewa?->env);
        self::assertSame('INTENT', $cfg->esewa?->intent?->productCode);
        self::assertNull($cfg->khalti);
        self::assertNull($cfg->fonepay?->username);
        self::assertSame("line1\nline2", $cfg->connectips?->privateKeyPem);
        self::assertSame('NPR', $cfg->cybersource?->currency);
        self::assertSame('', $cfg->nps?->merchantName);
        self::assertNull($cfg->imepay);

        $p = Payments::create($cfg, new MockTransport(static fn () => ['body' => []]));
        self::assertSame([ProviderId::Esewa, ProviderId::Fonepay, ProviderId::ConnectIps, ProviderId::CyberSource, ProviderId::Nps], $p->enabled());
        self::assertSame(ProviderId::Fonepay, $p->adapter('fonepay')->id());
        self::assertSame(ProviderId::Esewa, $p->esewa()->id());
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessage('payment provider "khalti" is not configured');
        $p->get(ProviderId::Khalti);
    }
}
