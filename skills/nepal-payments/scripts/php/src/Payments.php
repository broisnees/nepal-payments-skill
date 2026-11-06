<?php

declare(strict_types=1);

namespace NepalPayments;

use NepalPayments\ConnectIps\ConnectIpsAdapter;
use NepalPayments\ConnectIps\ConnectIpsConfig;
use NepalPayments\CyberSource\CyberSourceAdapter;
use NepalPayments\CyberSource\CyberSourceConfig;
use NepalPayments\Esewa\EsewaAdapter;
use NepalPayments\Esewa\EsewaConfig;
use NepalPayments\Esewa\EsewaIntentConfig;
use NepalPayments\Fonepay\FonepayAdapter;
use NepalPayments\Fonepay\FonepayConfig;
use NepalPayments\Http\CurlTransport;
use NepalPayments\Http\HttpClient;
use NepalPayments\Http\HttpTransport;
use NepalPayments\ImePay\ImePayAdapter;
use NepalPayments\ImePay\ImePayConfig;
use NepalPayments\Khalti\KhaltiAdapter;
use NepalPayments\Khalti\KhaltiConfig;
use NepalPayments\NepalPay\NepalPayAdapter;
use NepalPayments\NepalPay\NepalPayConfig;
use NepalPayments\Nps\NpsAdapter;
use NepalPayments\Nps\NpsConfig;

/**
 * One interface over Nepali payment providers.
 *
 *     $payments = Payments::create(Payments::configFromEnv());
 *     $r = $payments->get(ProviderId::Khalti)->initiate(new InitiateInput($orderId, $amountPaisa, 'Order 42', $returnUrl));
 *     $v = $payments->get(ProviderId::Khalti)->verify(new VerifyInput($orderId, $amountPaisa, $providerRef));
 */
final class Payments
{
    /** @param array<string, PaymentAdapter> $built keyed by ProviderId value */
    private function __construct(private readonly array $built)
    {
    }

    public static function create(PaymentsConfig $cfg, ?HttpTransport $transport = null): self
    {
        $http = new HttpClient($transport ?? new CurlTransport());
        $built = [];
        if ($cfg->esewa !== null) {
            $built['esewa'] = new EsewaAdapter($cfg->esewa, $http);
        }
        if ($cfg->khalti !== null) {
            $built['khalti'] = new KhaltiAdapter($cfg->khalti, $http);
        }
        if ($cfg->fonepay !== null) {
            $built['fonepay'] = new FonepayAdapter($cfg->fonepay, $http);
        }
        if ($cfg->connectips !== null) {
            $built['connectips'] = new ConnectIpsAdapter($cfg->connectips, $http);
        }
        if ($cfg->cybersource !== null) {
            $built['cybersource'] = new CyberSourceAdapter($cfg->cybersource);
        }
        if ($cfg->nps !== null) {
            $built['nps'] = new NpsAdapter($cfg->nps, $http);
        }
        if ($cfg->imepay !== null) {
            $built['imepay'] = new ImePayAdapter($cfg->imepay, $http);
        }
        if ($cfg->nepalpay !== null) {
            $built['nepalpay'] = new NepalPayAdapter($cfg->nepalpay, $http);
        }

        return new self($built);
    }

    /**
     * Access a configured provider (also accepts the wire string, e.g. a route param).
     *
     * @throws \LogicException when the provider is unknown or not configured
     */
    public function get(ProviderId|string $id): PaymentAdapter
    {
        $key = $id instanceof ProviderId ? $id->value : $id;
        if (!isset($this->built[$key])) {
            throw new \LogicException("payment provider \"{$key}\" is not configured");
        }

        return $this->built[$key];
    }

    /** Untyped access for generic handlers keyed by a route param (same as get()). */
    public function adapter(string $id): PaymentAdapter
    {
        return $this->get($id);
    }

    /** @return list<ProviderId> */
    public function enabled(): array
    {
        return array_map(static fn (string $k): ProviderId => ProviderId::from($k), array_keys($this->built));
    }

    public function esewa(): EsewaAdapter
    {
        $a = $this->get(ProviderId::Esewa);
        assert($a instanceof EsewaAdapter);

        return $a;
    }

    public function khalti(): KhaltiAdapter
    {
        $a = $this->get(ProviderId::Khalti);
        assert($a instanceof KhaltiAdapter);

        return $a;
    }

    public function fonepay(): FonepayAdapter
    {
        $a = $this->get(ProviderId::Fonepay);
        assert($a instanceof FonepayAdapter);

        return $a;
    }

    public function connectIps(): ConnectIpsAdapter
    {
        $a = $this->get(ProviderId::ConnectIps);
        assert($a instanceof ConnectIpsAdapter);

        return $a;
    }

    public function cyberSource(): CyberSourceAdapter
    {
        $a = $this->get(ProviderId::CyberSource);
        assert($a instanceof CyberSourceAdapter);

        return $a;
    }

    public function nps(): NpsAdapter
    {
        $a = $this->get(ProviderId::Nps);
        assert($a instanceof NpsAdapter);

        return $a;
    }

    public function imePay(): ImePayAdapter
    {
        $a = $this->get(ProviderId::ImePay);
        assert($a instanceof ImePayAdapter);

        return $a;
    }

    public function nepalPay(): NepalPayAdapter
    {
        $a = $this->get(ProviderId::NepalPay);
        assert($a instanceof NepalPayAdapter);

        return $a;
    }

    /**
     * Build config from environment variables (same names as the TS paymentsConfigFromEnv / references/env.md).
     * A provider is enabled when its required vars are non-empty. Default source: $_ENV, then getenv().
     *
     * @param array<string, string|null>|null $env
     */
    public static function configFromEnv(?array $env = null): PaymentsConfig
    {
        if ($env === null) {
            $env = [];
            foreach (getenv() as $k => $v) {
                if (is_string($v)) {
                    $env[(string) $k] = $v;
                }
            }
            foreach ($_ENV as $k => $v) {
                if (is_string($v)) {
                    $env[(string) $k] = $v;
                }
            }
        }
        $get = static fn (string $k): ?string => isset($env[$k]) && is_string($env[$k]) ? $env[$k] : null;
        $set = static fn (string $k): bool => ($get($k) ?? '') !== '';
        $mode = static fn (string $k): Environment => Environment::fromMode($get($k));

        $esewa = $khalti = $fonepay = $connectips = $cybersource = $nps = $imepay = $nepalpay = null;
        if ($set('ESEWA_PRODUCT_CODE') && $set('ESEWA_SECRET_KEY')) {
            $esewa = new EsewaConfig(
                $mode('ESEWA_ENV'),
                (string) $get('ESEWA_PRODUCT_CODE'),
                (string) $get('ESEWA_SECRET_KEY'),
                $set('ESEWA_INTENT_PRODUCT_CODE') && $set('ESEWA_INTENT_ACCESS_KEY')
                    ? new EsewaIntentConfig((string) $get('ESEWA_INTENT_PRODUCT_CODE'), (string) $get('ESEWA_INTENT_ACCESS_KEY'), $get('ESEWA_INTENT_BASE_URL'))
                    : null,
            );
        }
        if ($set('KHALTI_SECRET_KEY') && $set('KHALTI_WEBSITE_URL')) {
            $khalti = new KhaltiConfig($mode('KHALTI_ENV'), (string) $get('KHALTI_SECRET_KEY'), (string) $get('KHALTI_WEBSITE_URL'));
        }
        if ($set('FONEPAY_MERCHANT_CODE') && $set('FONEPAY_SECRET_KEY')) {
            $fonepay = new FonepayConfig(
                $mode('FONEPAY_ENV'),
                (string) $get('FONEPAY_MERCHANT_CODE'),
                (string) $get('FONEPAY_SECRET_KEY'),
                $get('FONEPAY_USERNAME'),
                $get('FONEPAY_PASSWORD'),
            );
        }
        if ($set('CONNECTIPS_MERCHANT_ID') && $set('CONNECTIPS_APP_ID') && $set('CONNECTIPS_PRIVATE_KEY_PEM')) {
            $connectips = new ConnectIpsConfig(
                $mode('CONNECTIPS_ENV'),
                (string) $get('CONNECTIPS_MERCHANT_ID'),
                (string) $get('CONNECTIPS_APP_ID'),
                $get('CONNECTIPS_APP_NAME') ?? '',
                $get('CONNECTIPS_APP_PASSWORD') ?? '',
                str_replace('\n', "\n", (string) $get('CONNECTIPS_PRIVATE_KEY_PEM')),
            );
        }
        if ($set('CYBERSOURCE_PROFILE_ID') && $set('CYBERSOURCE_ACCESS_KEY') && $set('CYBERSOURCE_SECRET_KEY')) {
            $cybersource = new CyberSourceConfig(
                $mode('CYBERSOURCE_ENV'),
                (string) $get('CYBERSOURCE_PROFILE_ID'),
                (string) $get('CYBERSOURCE_ACCESS_KEY'),
                (string) $get('CYBERSOURCE_SECRET_KEY'),
                currency: $get('CYBERSOURCE_CURRENCY') ?? 'NPR',
            );
        }
        if ($set('NPS_MERCHANT_ID') && $set('NPS_SECRET_KEY')) {
            $nps = new NpsConfig(
                $mode('NPS_ENV'),
                (string) $get('NPS_MERCHANT_ID'),
                $get('NPS_MERCHANT_NAME') ?? '',
                $get('NPS_API_USERNAME') ?? '',
                $get('NPS_API_PASSWORD') ?? '',
                (string) $get('NPS_SECRET_KEY'),
            );
        }
        if ($set('IMEPAY_MERCHANT_CODE') && $set('IMEPAY_USERNAME')) {
            $imepay = new ImePayConfig(
                $mode('IMEPAY_ENV'),
                (string) $get('IMEPAY_MERCHANT_CODE'),
                (string) $get('IMEPAY_USERNAME'),
                $get('IMEPAY_PASSWORD') ?? '',
                $get('IMEPAY_MODULE') ?? '',
            );
        }

        if ($set('NEPALPAY_ACQUIRER_ID') && $set('NEPALPAY_MERCHANT_ID') && $set('NEPALPAY_USERNAME') && $set('NEPALPAY_PRIVATE_KEY_PEM')) {
            $oauth = $set('NEPALPAY_CLIENT_ID');
            $ws = $set('NEPALPAY_WS_URL');
            $nepalpay = new NepalPayConfig(
                $mode('NEPALPAY_ENV'),
                (string) $get('NEPALPAY_ACQUIRER_ID'),
                (string) $get('NEPALPAY_MERCHANT_ID'),
                $get('NEPALPAY_MERCHANT_NAME') ?? '',
                $get('NEPALPAY_MCC') ?? '',
                $get('NEPALPAY_MERCHANT_CITY') ?? 'Kathmandu',
                $get('NEPALPAY_MERCHANT_POSTAL_CODE') ?? '44600',
                $get('NEPALPAY_STORE_LABEL') ?? 'Store1',
                (string) $get('NEPALPAY_USERNAME'),
                $get('NEPALPAY_PASSWORD') ?? '',
                str_replace('\n', "\n", (string) $get('NEPALPAY_PRIVATE_KEY_PEM')),
                $get('NEPALPAY_TERMINAL_LABEL'),
                $oauth ? 'oauth' : 'basic',
                $oauth ? $get('NEPALPAY_CLIENT_ID') : null,
                $oauth ? ($get('NEPALPAY_CLIENT_SECRET') ?? '') : null,
                nchlPublicKeyPem: $set('NEPALPAY_NCHL_PUBLIC_KEY_PEM') ? str_replace('\n', "\n", (string) $get('NEPALPAY_NCHL_PUBLIC_KEY_PEM')) : null,
                wsUrl: $ws ? $get('NEPALPAY_WS_URL') : null,
                wsUsername: $ws ? $get('NEPALPAY_WS_USERNAME') : null,
                wsApiToken: $ws ? $get('NEPALPAY_WS_API_TOKEN') : null,
            );
        }

        return new PaymentsConfig($esewa, $khalti, $fonepay, $connectips, $cybersource, $nps, $imepay, $nepalpay);
    }

    /**
     * Short, provider-safe attempt id: <= 20 chars, [A-Z0-9] (fits connectIPS TXNID 20, Fonepay PRN 25,
     * eSewa uuid charset, Khalti/NPS/IME/CyberSource limits). Example: "P1KX3M9Q2ZAB7C4D8E".
     */
    public static function newOrderId(string $prefix = 'P'): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        $ms = (int) floor(microtime(true) * 1000);
        $time = '';
        do {
            $time = $alphabet[$ms % 36] . $time;
            $ms = intdiv($ms, 36);
        } while ($ms > 0);
        $tail = '';
        while (strlen($tail) < 10) {
            foreach (unpack('C*', random_bytes(16)) ?: [] as $b) {
                if ($b < 252 && strlen($tail) < 10) { // 252 = 7 * 36: rejection sampling, no modulo bias
                    $tail .= $alphabet[$b % 36];
                }
            }
        }

        return substr($prefix . $time . $tail, 0, 20);
    }
}
