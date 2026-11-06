<?php

declare(strict_types=1);

namespace NepalPayments\HamroPay;

use NepalPayments\Crypto;
use NepalPayments\FormResult;
use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * Hamro Pay Checkout (Hamro Patro's wallet): https://hamropay.com.np/checkout/developer/reference/
 * Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
 * merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook signing secret.
 *
 * Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
 *       {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
 *
 * Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
 *   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
 *   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
 *   get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
 *   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
 * transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
 */
final class HamroPayAdapter implements PaymentAdapter
{
    public const MIN_PAISA = 1000;
    public const MAX_PAISA = 5_000_000;

    private const API = ['sandbox' => 'https://uat-payclient.hamropatro.com', 'production' => 'https://payclient.hamropatro.com'];
    private const SANDBOX_GATEWAY = 'https://uat-checkout-pay.hamropatro.com/api/checkout';
    private const TXN_STATUS = [
        'COMPLETED' => PaymentStatus::Paid,
        'FAILED' => PaymentStatus::Failed,
        'PENDING' => PaymentStatus::Pending,
        'PROCESSING' => PaymentStatus::Pending,
        'NOT_INITIATED' => PaymentStatus::NotFound,
        'CANCELED' => PaymentStatus::Canceled,
        'CANCELLED' => PaymentStatus::Canceled,
    ];

    private readonly string $api;
    private readonly ?string $gateway;

    public function __construct(
        private readonly HamroPayConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->api = (string) preg_replace('#/\z#', '', $cfg->apiBaseUrl ?? self::API[$cfg->env->value]);
        $this->gateway = $cfg->gatewayUrl ?? ($cfg->env->value === 'sandbox' ? self::SANDBOX_GATEWAY : null);
    }

    public function id(): ProviderId
    {
        return ProviderId::HamroPay;
    }

    /**
     * base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a value would let two
     * different tuples share a signature: refuse it instead.
     *
     * @param list<string|int> $values
     * @throws \InvalidArgumentException when a value contains a comma
     */
    public static function sign(string $secret, array $values): string
    {
        $parts = array_map(static fn (string|int $v): string => (string) $v, $values);
        foreach ($parts as $v) {
            if (str_contains($v, ',')) {
                throw new \InvalidArgumentException('hamropay: signed values must not contain commas');
            }
        }

        return Crypto::toBase64(Crypto::hmac('sha512', $secret, implode(',', $parts)));
    }

    /**
     * Create Session, then the signed form for the gateway. merchantTxnId = orderId (<= 25 chars).
     * Persist providerRef (the sessionId). A session lives about 10 minutes.
     * A timeout here may still have created the session on Hamro Pay's side: retry with a NEW orderId.
     *
     * @param array<string, string>|null $metadata
     */
    public function initiate(InitiateInput $input, ?string $remarks = null, ?array $metadata = null): FormResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::HamroPay);
        if ($input->amountPaisa < self::MIN_PAISA || $input->amountPaisa > self::MAX_PAISA) {
            throw new PaymentException('Hamro Pay accepts Rs 10 to Rs 50,000 per transaction', ProviderId::HamroPay, 'invalid_amount');
        }
        if (preg_match('/^[A-Za-z0-9-]{1,25}\z/', $input->orderId) !== 1) {
            throw new PaymentException('Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]', ProviderId::HamroPay, 'invalid_order_id');
        }
        if ($this->gateway === null) {
            throw new \LogicException('hamropay: gatewayUrl is required in production (Hamro Pay issues the live gateway host)');
        }
        $transactionAmount = (string) $input->amountPaisa; // signed and sent as the same string
        $name = Js::firstTruthy($input->description) ?? 'Payment';
        $body = [
            'merchantTxnId' => $input->orderId,
            'merchantId' => $this->cfg->merchantId,
            'transactionAmount' => $transactionAmount,
            'successRedirectionUrl' => $input->returnUrl,
            'failedRedirectionUrl' => $input->failureUrl ?? $input->returnUrl,
            // int / int stays an int when whole, so the JSON number matches TS (100, not 100.0)
            'productList' => [['name' => $name, 'description' => $name, 'price' => $input->amountPaisa / 100, 'quantity' => 1]],
        ];
        if (Js::truthy($input->customer?->phone)) {
            $body['phone_number'] = $input->customer->phone;
        }
        if ($metadata !== null) {
            $body['metadata'] = (object) $metadata;
        }
        $session = $this->post(
            '/v1/checkout/sessionId',
            $body,
            [$input->orderId, $transactionAmount, $this->cfg->merchantId, $this->cfg->clientId, $this->cfg->clientApiKey],
        );
        $sessionId = $session['sessionId'] ?? null;
        if (!is_string($sessionId) || $sessionId === '') {
            throw new PaymentException('Hamro Pay: Create Session returned no sessionId', ProviderId::HamroPay, 'no_session', 200, $session);
        }
        if (($session['merchantId'] ?? null) !== null && $session['merchantId'] !== $this->cfg->merchantId) {
            throw new PaymentException('Hamro Pay: Create Session answered for a different merchantId', ProviderId::HamroPay, 'merchant_mismatch', 200, $session);
        }
        $token = self::sign($this->cfg->clientSecret, [$this->cfg->merchantId, $input->orderId, $sessionId, $transactionAmount, $this->cfg->clientId, $this->cfg->clientApiKey]);

        return new FormResult(
            $this->gateway,
            [
                'merchant_id' => $this->cfg->merchantId,
                'session_id' => $sessionId,
                'token' => $token,
                'merchant_transaction_id' => $input->orderId,
                'remarks' => Js::slice($remarks ?? $input->description, 250),
            ],
            providerRef: $sessionId,
        );
    }

    /** Get Transaction: authoritative. amount is rupees, and 0 until the payment finishes. */
    public function verify(VerifyInput $input): VerifyResult
    {
        $orderId = $input->orderId;
        $r = $this->post(
            '/v1/checkout/transaction',
            ['merchantId' => $this->cfg->merchantId, 'merchantTxnId' => $orderId],
            [$orderId, $this->cfg->merchantId, $this->cfg->clientId, $this->cfg->clientApiKey],
            2,
        );
        // The reference names it merchantTransactionId; the live API answers merchantTxnId.
        $echoed = $r['merchantTransactionId'] ?? $r['merchantTxnId'] ?? null;
        if ($echoed !== null && $echoed !== '' && Js::toString($echoed) !== $orderId) {
            throw new PaymentException('Hamro Pay: transaction answer is for a different merchantTxnId', ProviderId::HamroPay, 'id_mismatch', 200, $r);
        }
        $status = self::TXN_STATUS[strtoupper(Js::toString($r['status'] ?? ''))] ?? PaymentStatus::Unknown;
        $amount = $r['amount'] ?? null;
        $tracking = $r['trackingId'] ?? null;

        return new VerifyResult(
            ProviderId::HamroPay,
            $status,
            $orderId,
            $status === PaymentStatus::Paid && $amount !== null
                ? Money::rupeesToPaisa(is_int($amount) || is_float($amount) || is_string($amount) ? $amount : Js::toString($amount))
                : null,
            is_string($tracking) && $tracking !== '' ? $tracking : null,
            $r,
        );
    }

    /** Success and failure redirects carry ?MerchantTxnId=<your orderId>. */
    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);

        return Js::firstTruthy($p['MerchantTxnId'] ?? null, $p['merchantTxnId'] ?? null);
    }

    /**
     * Check a webhook's "Signature" header. Hamro Pay signs its own rendering of the amount (a double), which may be
     * "1200", "1200.0" or "1200.00", so every form of the PARSED number is tried. Fulfil only after verify().
     *
     * @param array<array-key, mixed> $body JSON-decoded webhook body.
     */
    public function verifyWebhook(array $body, ?string $signature): bool
    {
        $secret = $this->cfg->webhookSecret;
        if ($secret === null || $secret === '') {
            throw new \LogicException('hamropay: webhookSecret required to verify webhooks');
        }
        if ($signature === null || $signature === '') {
            return false;
        }
        $amount = $body['amount'] ?? null;
        if (!(is_int($amount) || is_float($amount)) || !is_finite((float) $amount)) {
            return false;
        }
        $prefix = [$body['merchantTxnId'] ?? null, $body['merchantId'] ?? null, $body['status'] ?? null];
        foreach ($prefix as $v) {
            if (!is_string($v) || $v === '' || str_contains($v, ',')) {
                return false;
            }
        }
        $x = (float) $amount;
        $ok = false;
        foreach (array_unique([Js::numberToString($x), Js::toFixed($x, 2), Js::numberToString($x) . '.0', Js::toFixed($x, 1)]) as $a) {
            if (Crypto::safeEqual(self::sign($secret, [...$prefix, $a]), $signature)) {
                $ok = true;
            }
        }

        return $ok;
    }

    /**
     * @param array<string, mixed> $body
     * @param list<string|int> $signed
     * @return array<array-key, mixed>
     */
    private function post(string $path, array $body, array $signed, int $retries = 0): array
    {
        $res = $this->http->request(
            ProviderId::HamroPay,
            "{$this->api}{$path}",
            'POST',
            [
                'Signature' => self::sign($this->cfg->clientSecret, $signed),
                'Client-Id' => $this->cfg->clientId,
                'Client-API-Key' => $this->cfg->clientApiKey,
                // The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on
                // the next call (Hamro Pay's own sample measured every second request failing on UAT).
                'Connection' => 'close',
            ],
            $body,
            $this->cfg->timeoutMs,
            $retries,
        );
        $d = $res->data;
        if ($res->status === 401 || (is_array($d) && ($d['code'] ?? null) === 16)) {
            throw new PaymentException('Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)', ProviderId::HamroPay, 'unauthorized', $res->status, $d);
        }
        if ($res->status !== 200 || !is_array($d)) {
            $msg = is_array($d) && is_string($d['message'] ?? null) ? $d['message'] : Js::slice($res->text, 200);
            $code = is_array($d) && ($d['code'] ?? null) !== null ? 'code_' . Js::toString($d['code']) : "http_{$res->status}";
            throw new PaymentException("Hamro Pay {$path} failed: {$msg}", ProviderId::HamroPay, $code, $res->status, $d);
        }

        return $d;
    }
}
