<?php

declare(strict_types=1);

namespace NepalPayments\Esewa;

use NepalPayments\Crypto;
use NepalPayments\FormResult;
use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Internal\Json;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * eSewa — https://developer.esewa.com.np
 *
 *  1. ePay v2 (web, also in a mobile WebView): signed form POST -> eSewa -> success_url?data=<base64 JSON>
 *     -> verify response signature -> status API (authoritative).
 *  2. Intent (mobile app-to-app): server books -> app opens deeplink -> eSewa POSTs callback_url -> status API.
 *
 * Signature (both): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in `signed_field_names` order.
 */
final class EsewaAdapter implements PaymentAdapter
{
    private const URLS = [
        'sandbox' => [
            'form' => 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
            'status' => 'https://rc.esewa.com.np/api/epay/transaction/status/',
            'intent' => 'https://rc-checkout.esewa.com.np/api/client/intent/payment',
        ],
        'production' => [
            'form' => 'https://epay.esewa.com.np/api/epay/main/v2/form',
            'status' => 'https://esewa.com.np/api/epay/transaction/status/',
            'intent' => null, // eSewa provides the production Intent host at go-live — pass intent baseUrl
        ],
    ];

    private const EPAY_STATUS = [
        'COMPLETE' => PaymentStatus::Paid,
        'PENDING' => PaymentStatus::Pending,
        'AMBIGUOUS' => PaymentStatus::Pending, // "payment is at halt state" — keep re-checking
        'FULL_REFUND' => PaymentStatus::Refunded,
        'PARTIAL_REFUND' => PaymentStatus::PartiallyRefunded,
        'NOT_FOUND' => PaymentStatus::NotFound, // session expired / never paid / wrong amount
        'CANCELED' => PaymentStatus::Canceled,
    ];

    private const INTENT_STATUS = [
        'SUCCESS' => PaymentStatus::Paid,
        'BOOKED' => PaymentStatus::Pending,
        'PENDING' => PaymentStatus::Pending,
        'FAILED' => PaymentStatus::Failed,
        'CANCELED' => PaymentStatus::Canceled,
        'REVERTED' => PaymentStatus::Refunded,
    ];

    private const EPAY_SIGNED = ['total_amount', 'transaction_uuid', 'product_code'];

    private readonly string $formUrl;
    private readonly string $statusUrl;
    private readonly string $secret;

    public function __construct(
        private readonly EsewaConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $urls = self::URLS[$cfg->env->value];
        $this->formUrl = $cfg->formUrl ?? $urls['form'];
        $this->statusUrl = $cfg->statusUrl ?? $urls['status'];
        $this->secret = str_replace('&amp;', '&', $cfg->secretKey);
    }

    public function id(): ProviderId
    {
        return ProviderId::Esewa;
    }

    /**
     * base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order.
     *
     * @param array<string, string|int|float|null> $fields
     * @param list<string> $order
     */
    public static function sign(string $key, array $fields, array $order): string
    {
        $parts = [];
        foreach ($order as $f) {
            $v = $fields[$f] ?? '';
            $parts[] = $f . '=' . (is_string($v) ? $v : Js::toString($v));
        }

        return Crypto::toBase64(Crypto::hmac('sha256', $key, implode(',', $parts)));
    }

    /**
     * Returns a form to auto-submit (application/x-www-form-urlencoded POST).
     * `$input->amountPaisa` is the TOTAL charged; tax/service/delivery are an optional breakdown INCLUDED in it
     * (eSewa's `amount` = total - tax - service - delivery). Keep returnUrl/failureUrl free of query strings —
     * eSewa appends `?data=...`; put your attempt id in the PATH.
     */
    public function initiate(InitiateInput $input, int $taxPaisa = 0, int $serviceChargePaisa = 0, int $deliveryChargePaisa = 0): FormResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::Esewa);
        if (preg_match('/^[A-Za-z0-9-]+\z/', $input->orderId) !== 1) {
            throw new PaymentException("eSewa transaction_uuid allows only letters, digits and '-'", ProviderId::Esewa, 'invalid_order_id');
        }
        $base = $input->amountPaisa - $taxPaisa - $serviceChargePaisa - $deliveryChargePaisa;
        if ($taxPaisa < 0 || $serviceChargePaisa < 0 || $deliveryChargePaisa < 0 || $base <= 0) {
            throw new PaymentException('eSewa: tax/charges must be non-negative paisa and less than the total', ProviderId::Esewa, 'invalid_amount');
        }
        // Format ONCE and use the same strings in the form and in the signature ("110" vs "110.0" -> ES104).
        $fields = [
            'amount' => Money::paisaToRupees($base),
            'tax_amount' => Money::paisaToRupees($taxPaisa),
            'product_service_charge' => Money::paisaToRupees($serviceChargePaisa),
            'product_delivery_charge' => Money::paisaToRupees($deliveryChargePaisa),
            'total_amount' => Money::paisaToRupees($input->amountPaisa),
            'transaction_uuid' => $input->orderId,
            'product_code' => $this->cfg->productCode,
            'success_url' => $input->returnUrl,
            'failure_url' => $input->failureUrl ?? $input->returnUrl,
            'signed_field_names' => implode(',', self::EPAY_SIGNED),
        ];
        $fields['signature'] = self::sign($this->secret, $fields, self::EPAY_SIGNED);

        return new FormResult($this->formUrl, $fields);
    }

    /**
     * Decode + verify the base64 `data` param from success_url. Does NOT prove payment; call verify().
     * Numeric fields are signed over their raw JSON text ("1000.0" stays "1000.0"); a comma-stripped
     * total_amount is tried too.
     *
     * @throws PaymentException malformed_callback
     */
    public function parseSuccess(string $data): EsewaSuccess
    {
        try {
            $text = Crypto::fromBase64($data);
            $payload = Json::decode($text);
        } catch (\InvalidArgumentException|\JsonException $e) {
            throw new PaymentException('eSewa: malformed success payload', ProviderId::Esewa, 'malformed_callback', 400, $data, $e);
        }
        if (!is_array($payload) || !is_string($payload['signed_field_names'] ?? null)) {
            throw new PaymentException('eSewa: malformed success payload', ProviderId::Esewa, 'malformed_callback', 400, $payload);
        }
        $order = array_map('trim', explode(',', $payload['signed_field_names']));
        $fields = [];
        foreach ($order as $f) {
            $fields[$f] = self::rawValue($text, $payload, $f);
        }
        $signature = $payload['signature'] ?? null;
        $ok = is_string($signature) && Crypto::safeEqual(self::sign($this->secret, $fields, $order), $signature);
        // eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed. Try both.
        if (!$ok && is_string($signature) && isset($fields['total_amount']) && str_contains($fields['total_amount'], ',')) {
            $alt = self::sign($this->secret, ['total_amount' => str_replace(',', '', $fields['total_amount'])] + $fields, $order);
            $ok = Crypto::safeEqual($alt, $signature);
        }

        return new EsewaSuccess($payload, $ok);
    }

    /**
     * Authoritative check via the status API. If `callback['data']` is present (success redirect) its signature
     * and transaction_uuid/product_code are verified too. `amountPaisa` MUST be the TOTAL you charged: eSewa
     * returns NOT_FOUND for a wrong total, which doubles as an amount check.
     */
    public function verify(VerifyInput $input): VerifyResult
    {
        $signatureValid = null;
        $data = $input->callback['data'] ?? '';
        if ($data !== '') {
            $parsed = $this->parseSuccess($data);
            $signatureValid = $parsed->signatureValid;
            if (($parsed->payload['transaction_uuid'] ?? null) !== $input->orderId || ($parsed->payload['product_code'] ?? null) !== $this->cfg->productCode) {
                throw new PaymentException('eSewa: callback does not match this attempt', ProviderId::Esewa, 'callback_mismatch', 400, $parsed->payload);
            }
            if (!$signatureValid && $this->cfg->strictSignature) {
                throw new PaymentException('eSewa: invalid response signature', ProviderId::Esewa, 'invalid_signature', 400, $parsed->payload);
            }
        }
        $s = $this->statusCheck($input->orderId, $input->amountPaisa);
        $total = $s['total_amount'] ?? null;

        return new VerifyResult(
            ProviderId::Esewa,
            self::EPAY_STATUS[Js::toString($s['status'])] ?? PaymentStatus::Unknown,
            $input->orderId,
            is_int($total) || is_float($total) || is_string($total) ? Money::rupeesToPaisa($total) : null,
            isset($s['ref_id']) ? Js::toString($s['ref_id']) : null,
            ['status' => $s, 'signatureValid' => $signatureValid],
        );
    }

    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);
        if (($p['data'] ?? '') !== '') {
            try {
                $payload = Crypto::base64Json($p['data']);
            } catch (\Throwable) {
                return null;
            }
            $uuid = is_array($payload) ? ($payload['transaction_uuid'] ?? '') : '';
            $id = Js::toString($uuid);

            return $id !== '' ? $id : null;
        }

        // from your path param on failure_url
        return Js::firstTruthy($p['orderId'] ?? null, $p['order_id'] ?? null, $p['transaction_uuid'] ?? null);
    }

    // ------------------------------------------------------------------ Intent (mobile app-to-app)

    /**
     * Book an Intent payment. Open `deeplink` in the app (or mobile browser). Persist `providerRef`
     * ("bookingId|correlationId") on the attempt. Use whole-rupee amounts: decimal Intent signing is undocumented.
     *
     * @param array<string, string>|null $properties snake_case keys; shown to the user. Default: remarks = orderId.
     */
    public function intentBook(string $orderId, int $amountPaisa, string $callbackUrl, string $redirectUrl, ?array $properties = null): EsewaIntentBooking
    {
        [$productCode, $accessKey, $baseUrl] = $this->requireIntent();
        Money::assertPaisa($amountPaisa, ProviderId::Esewa);
        // Number(paisaToRupees(x)): a JSON number, signed as its JS string form ("100", "100.5").
        $amount = $amountPaisa % 100 === 0 ? intdiv($amountPaisa, 100) : (float) Money::paisaToRupees($amountPaisa);
        $order = ['product_code', 'amount', 'transaction_uuid'];
        $body = [
            'product_code' => $productCode,
            'amount' => $amount,
            'transaction_uuid' => $orderId,
            'signed_field_names' => implode(',', $order),
            'signature' => self::sign($accessKey, ['product_code' => $productCode, 'amount' => Js::toString($amount), 'transaction_uuid' => $orderId], $order),
            'callback_url' => $callbackUrl,
            'redirect_url' => $redirectUrl,
            'properties' => (object) ($properties ?? ['remarks' => $orderId]),
        ];
        $res = $this->http->request(ProviderId::Esewa, "{$baseUrl}/book", 'POST', [], $body, $this->cfg->timeoutMs);
        $d = is_array($res->data) && is_array($res->data['data'] ?? null) ? $res->data['data'] : null;
        if ($d === null || !Js::truthy($d['booking_id'] ?? null)) {
            throw new PaymentException('eSewa intent book failed: ' . $this->errorMessage($res->data, $res->text), ProviderId::Esewa, $this->errorCode($res->data, $res->status), $res->status, $res->data);
        }
        $bookingId = Js::toString($d['booking_id']);
        $correlationId = isset($d['correlation_id']) ? Js::toString($d['correlation_id']) : '';

        return new EsewaIntentBooking(
            $bookingId,
            isset($d['deeplink']) ? Js::toString($d['deeplink']) : '',
            $correlationId,
            "{$bookingId}|{$correlationId}",
            $res->data,
        );
    }

    /**
     * Authoritative Intent status. `$providerRef` = "bookingId|correlationId" stored at booking.
     * Pass the stored amount: the status response has none, but the amount was signed at booking.
     */
    public function intentVerify(string $orderId, string $providerRef, ?int $amountPaisa = null): VerifyResult
    {
        [$productCode, $accessKey, $baseUrl] = $this->requireIntent();
        $parts = explode('|', $providerRef);
        $fields = ['booking_id' => $parts[0], 'product_code' => $productCode];
        if (array_key_exists(1, $parts)) {
            $fields['correlation_id'] = $parts[1];
        }
        $order = ['booking_id', 'product_code', 'correlation_id'];
        $body = $fields + ['signed_field_names' => implode(',', $order), 'signature' => self::sign($accessKey, $fields, $order)];
        $res = $this->http->request(ProviderId::Esewa, "{$baseUrl}/status", 'POST', [], $body, $this->cfg->timeoutMs, 2);
        $d = is_array($res->data) && is_array($res->data['data'] ?? null) ? $res->data['data'] : null;
        if ($d === null || !Js::truthy($d['status'] ?? null)) {
            throw new PaymentException('eSewa intent status failed: ' . $this->errorMessage($res->data, $res->text), ProviderId::Esewa, $this->errorCode($res->data, $res->status), $res->status, $res->data);
        }
        if (Js::truthy($d['transaction_id'] ?? null) && $d['transaction_id'] !== $orderId) {
            throw new PaymentException('eSewa intent: status is for a different transaction', ProviderId::Esewa, 'callback_mismatch', 400, $d);
        }

        // Status response has no amount: the amount was fixed and signed at booking time.
        return new VerifyResult(
            ProviderId::Esewa,
            self::INTENT_STATUS[Js::toString($d['status'])] ?? PaymentStatus::Unknown,
            $orderId,
            $amountPaisa,
            isset($d['reference_code']) ? Js::toString($d['reference_code']) : null,
            $res->data,
        );
    }

    /** Cancel a booking that hasn't completed (e.g. user abandoned). Returns eSewa's decoded response. */
    public function intentCancel(string $providerRef): mixed
    {
        [$productCode, $accessKey, $baseUrl] = $this->requireIntent();
        $fields = ['booking_id' => explode('|', $providerRef)[0], 'product_code' => $productCode];
        $order = ['booking_id', 'product_code'];
        $body = $fields + ['signed_field_names' => implode(',', $order), 'signature' => self::sign($accessKey, $fields, $order)];

        return $this->http->request(ProviderId::Esewa, "{$baseUrl}/cancel", 'POST', [], $body, $this->cfg->timeoutMs)->data;
    }

    /**
     * Verify the signature on eSewa's Intent callback POST body (decoded JSON). Still call intentVerify() before fulfilling.
     *
     * @param array<array-key, mixed> $body
     */
    public function intentCallbackValid(array $body): bool
    {
        [, $accessKey] = $this->requireIntent();
        $names = $body['signed_field_names'] ?? null;
        $signature = $body['signature'] ?? null;
        if (!is_string($names) || !is_string($signature)) {
            return false;
        }
        $order = array_map('trim', explode(',', $names));
        $fields = [];
        foreach ($order as $f) {
            $v = $body[$f] ?? null;
            $fields[$f] = $v === null ? '' : Js::toString($v);
        }

        return Crypto::safeEqual(self::sign($accessKey, $fields, $order), $signature);
    }

    /** @return array<string, mixed> */
    private function statusCheck(string $orderId, int $amountPaisa): array
    {
        $qs = Js::urlSearchParams([
            'product_code' => $this->cfg->productCode,
            'total_amount' => Money::paisaToRupees($amountPaisa),
            'transaction_uuid' => $orderId,
        ]);
        $res = $this->http->request(ProviderId::Esewa, "{$this->statusUrl}?{$qs}", 'GET', [], null, $this->cfg->timeoutMs, 2);
        if ($res->status !== 200 || !is_array($res->data) || !array_key_exists('status', $res->data)) {
            $code = is_array($res->data) && array_key_exists('code', $res->data) ? 'esewa_' . Js::toString($res->data['code']) : "http_{$res->status}";
            throw new PaymentException('eSewa status check failed: ' . $this->errorMessage($res->data, $res->text), ProviderId::Esewa, $code, $res->status, $res->data);
        }

        return $res->data;
    }

    private function errorMessage(mixed $data, string $text): string
    {
        return is_array($data) && isset($data['error_message']) ? Js::toString($data['error_message']) : Js::slice($text, 200);
    }

    private function errorCode(mixed $data, int $status): string
    {
        return is_array($data) && isset($data['code']) ? Js::toString($data['code']) : "http_{$status}";
    }

    /** @return array{0: string, 1: string, 2: string} */
    private function requireIntent(): array
    {
        $intent = $this->cfg->intent;
        if ($intent === null) {
            throw new \LogicException('eSewa: configure `intent` credentials to use Intent payments');
        }
        $baseUrl = $intent->baseUrl ?? self::URLS[$this->cfg->env->value]['intent'];
        if ($baseUrl === null || $baseUrl === '') {
            throw new \LogicException('eSewa: production Intent baseUrl is issued by eSewa at go-live; set intent baseUrl');
        }

        return [$intent->productCode, $intent->accessKey, $baseUrl];
    }

    /**
     * Exact text of a field as eSewa sent it, so numbers keep their formatting ("1000.0" stays "1000.0").
     *
     * @param array<array-key, mixed> $payload
     */
    private static function rawValue(string $text, array $payload, string $field): string
    {
        $v = $payload[$field] ?? null;
        if (!is_int($v) && !is_float($v)) {
            return $v === null ? '' : Js::toString($v);
        }
        if (preg_match('/"' . preg_quote($field, '/') . '"\s*:\s*(-?[0-9][0-9.eE+-]*)/', $text, $m) === 1) {
            return $m[1];
        }

        return Js::toString($v);
    }
}
