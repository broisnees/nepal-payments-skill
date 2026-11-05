<?php

declare(strict_types=1);

namespace NepalPayments\Khalti;

use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\RedirectResult;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/
 *
 * Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
 *       -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".
 */
final class KhaltiAdapter implements PaymentAdapter
{
    private const HOST = ['sandbox' => 'https://dev.khalti.com', 'production' => 'https://khalti.com'];

    private const STATUS = [
        'completed' => PaymentStatus::Paid,
        'pending' => PaymentStatus::Pending,
        'initiated' => PaymentStatus::Pending, // user hasn't paid yet; Khalti flips it to Expired after the link expires
        'refunded' => PaymentStatus::Refunded,
        'partially refunded' => PaymentStatus::PartiallyRefunded,
        'expired' => PaymentStatus::Expired,
        'user canceled' => PaymentStatus::Canceled,
        'failed' => PaymentStatus::Failed,
    ];

    private readonly string $host;
    private readonly string $base;
    /** @var array<string, string> */
    private readonly array $auth;

    public function __construct(
        private readonly KhaltiConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        if ($cfg->secretKey === '') {
            throw new \InvalidArgumentException('khalti: secretKey is required');
        }
        $this->host = self::HOST[$cfg->env->value];
        $this->base = "{$this->host}/api/v2";
        $this->auth = ['Authorization' => 'Key ' . preg_replace('/^key\s+/i', '', $cfg->secretKey)];
    }

    public function id(): ProviderId
    {
        return ProviderId::Khalti;
    }

    /**
     * @param list<array{label: string, amount: int}>|null $amountBreakdown Must sum to amountPaisa.
     * @param list<array{identity: string, name: string, total_price: int, quantity: int, unit_price: int}>|null $productDetails
     * @param array<string, string> $merchantExtras Keys must start with "merchant_"; echoed back in the success payload.
     */
    public function initiate(InitiateInput $input, ?array $amountBreakdown = null, ?array $productDetails = null, array $merchantExtras = []): RedirectResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::Khalti);
        if ($input->amountPaisa < 1000) {
            throw new PaymentException('Khalti minimum is Rs 10 (1000 paisa)', ProviderId::Khalti, 'amount_too_low');
        }
        $body = [
            'return_url' => $input->returnUrl,
            'website_url' => $this->cfg->websiteUrl,
            'amount' => $input->amountPaisa, // integer paisa
            'purchase_order_id' => $input->orderId,
            'purchase_order_name' => Js::slice($input->description, 255),
        ];
        if ($input->customer !== null) {
            $body['customer_info'] = $input->customer->toObject();
        }
        if ($amountBreakdown !== null) {
            $body['amount_breakdown'] = $amountBreakdown;
        }
        if ($productDetails !== null) {
            $body['product_details'] = $productDetails;
        }
        foreach ($merchantExtras as $k => $v) {
            if (!str_starts_with((string) $k, 'merchant_')) {
                throw new \InvalidArgumentException("khalti: merchant extra keys must start with \"merchant_\", got \"{$k}\"");
            }
            $body[(string) $k] = $v;
        }
        // Trailing slash is REQUIRED: without it Khalti 301s and the POST body is lost. No retries: not idempotent.
        $res = $this->http->request(ProviderId::Khalti, "{$this->base}/epayment/initiate/", 'POST', $this->auth, $body, $this->cfg->timeoutMs);
        if ($res->status !== 200 || !is_array($res->data) || !Js::truthy($res->data['pidx'] ?? null)) {
            throw new PaymentException(self::errorMessage($res->data), ProviderId::Khalti, self::errorKey($res->data, $res->status), $res->status, $res->data);
        }

        return new RedirectResult(
            Js::toString($res->data['payment_url'] ?? ''),
            Js::toString($res->data['pidx']), // PERSIST THIS — lookup needs it and there is no lookup-by-order-id
            isset($res->data['expires_at']) ? Js::toString($res->data['expires_at']) : null,
            $res->data,
        );
    }

    /**
     * Lookup with the pidx stored at initiate time (`providerRef`). The lookup response has no purchase_order_id,
     * so trusting a callback pidx would let a payer replay another payment's pidx; a differing callback pidx throws.
     */
    public function verify(VerifyInput $input): VerifyResult
    {
        $pidx = $input->providerRef;
        if ($pidx === null || $pidx === '') {
            throw new PaymentException('khalti: stored pidx required for verify', ProviderId::Khalti, 'missing_pidx');
        }
        $cbPidx = $input->callback['pidx'] ?? '';
        if ($cbPidx !== '' && $cbPidx !== $pidx) {
            throw new PaymentException('khalti: callback pidx does not match stored pidx', ProviderId::Khalti, 'pidx_mismatch', 400, $input->callback);
        }

        $res = $this->http->request(ProviderId::Khalti, "{$this->base}/epayment/lookup/", 'POST', $this->auth, ['pidx' => $pidx], $this->cfg->timeoutMs, 2);
        $d = $res->data;
        // Expired / User canceled come back as HTTP 400 WITH a normal body — parse, don't throw.
        if (is_array($d) && is_string($d['status'] ?? null)) {
            $total = $d['total_amount'] ?? null;

            return new VerifyResult(
                ProviderId::Khalti,
                self::STATUS[strtolower($d['status'])] ?? PaymentStatus::Unknown,
                $input->orderId,
                is_int($total) ? $total : (is_float($total) && floor($total) === $total && abs($total) < 9.0E15 ? (int) $total : null),
                isset($d['transaction_id']) ? Js::toString($d['transaction_id']) : null,
                $d,
            );
        }
        if ($res->status === 404 || (is_array($d) && ($d['detail'] ?? null) === 'Not found.')) {
            return new VerifyResult(ProviderId::Khalti, PaymentStatus::NotFound, $input->orderId, null, null, $d);
        }

        throw new PaymentException(self::errorMessage($d), ProviderId::Khalti, self::errorKey($d, $res->status), $res->status, $d);
    }

    public function orderIdFromCallback(array $params): ?string
    {
        return Js::firstTruthy(Js::stringMap($params)['purchase_order_id'] ?? null);
    }

    /**
     * Refund a completed transaction (transaction_id from lookup). Full refund when $amountPaisa is null.
     * `$mobile` is required for payments made via bank/e-banking. Khalti's docs say partial refund `amount` is
     * paisa but their example shows "50.00": confirm the unit in sandbox before relying on partial refunds.
     */
    public function refund(string $transactionId, ?int $amountPaisa = null, ?string $mobile = null): mixed
    {
        $body = [];
        if ($amountPaisa !== null) {
            Money::assertPaisa($amountPaisa, ProviderId::Khalti);
            $body['amount'] = $amountPaisa;
        }
        if ($mobile !== null && $mobile !== '') {
            $body['mobile'] = $mobile;
        }
        $url = "{$this->host}/api/merchant-transaction/" . Js::encodeURIComponent($transactionId) . '/refund/';
        $res = $this->http->request(ProviderId::Khalti, $url, 'POST', $this->auth, $body, $this->cfg->timeoutMs);
        if ($res->status !== 200) {
            throw new PaymentException(self::errorMessage($res->data), ProviderId::Khalti, self::errorKey($res->data, $res->status), $res->status, $res->data);
        }

        return $res->data;
    }

    private static function errorKey(mixed $data, int $status): string
    {
        if ($status === 401) {
            return 'unauthorized';
        }

        return is_array($data) && Js::truthy($data['error_key'] ?? null) ? Js::toString($data['error_key']) : "http_{$status}";
    }

    private static function errorMessage(mixed $data): string
    {
        if (!is_array($data) || !Js::truthy($data)) {
            return 'Khalti error: ' . Js::slice(Js::toString($data), 200);
        }
        if (Js::truthy($data['detail'] ?? null)) {
            return 'Khalti: ' . Js::toString($data['detail']);
        }
        $fields = [];
        foreach ($data as $k => $v) {
            if ($k === 'error_key' || $k === 'status_code') {
                continue;
            }
            $fields[] = "{$k}: " . (is_array($v) && array_is_list($v) ? Js::join($v, ' ') : Js::toString($v));
        }

        return 'Khalti: ' . ($fields === [] ? 'unknown error' : implode('; ', $fields));
    }
}
