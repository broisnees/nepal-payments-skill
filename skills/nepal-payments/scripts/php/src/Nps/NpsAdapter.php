<?php

declare(strict_types=1);

namespace NepalPayments\Nps;

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
 * Nepal Payment Solution (NPS / NPX) OnePG.
 *
 * Auth: Basic base64(apiUsername:apiPassword) on every API call.
 * Signature: HMAC-SHA512(secretKey, values of payload keys sorted alphabetically (excluding Signature),
 *            concatenated with NO separator) as lowercase hex.
 * Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> NPS GETs your Notification URL
 *       + browser returns to ResponseUrl -> CheckTransactionStatus (authoritative).
 */
final class NpsAdapter implements PaymentAdapter
{
    private const URLS = [
        'sandbox' => ['api' => 'https://apisandbox.nepalpayment.com', 'gateway' => 'https://gatewaysandbox.nepalpayment.com/Payment/Index'],
        'production' => ['api' => 'https://apigateway.nepalpayment.com', 'gateway' => 'https://gateway.nepalpayment.com/Payment/Index'],
    ];

    private const STATUS = ['success' => PaymentStatus::Paid, 'fail' => PaymentStatus::Failed, 'failed' => PaymentStatus::Failed, 'pending' => PaymentStatus::Pending];

    private readonly string $api;
    private readonly string $gateway;
    /** @var array{MerchantId: string, MerchantName: string} */
    private readonly array $merchant;

    public function __construct(
        private readonly NpsConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->api = $cfg->apiBaseUrl ?? self::URLS[$cfg->env->value]['api'];
        $this->gateway = $cfg->gatewayUrl ?? self::URLS[$cfg->env->value]['gateway'];
        $this->merchant = ['MerchantId' => $cfg->merchantId, 'MerchantName' => $cfg->merchantName];
    }

    public function id(): ProviderId
    {
        return ProviderId::Nps;
    }

    /** Sorted-keys, no-separator HMAC-SHA512 (lowercase hex). @param array<string, string> $payload */
    public static function sign(string $secretKey, array $payload): string
    {
        $keys = array_map('strval', array_keys($payload));
        $keys = array_values(array_filter($keys, static fn (string $k): bool => $k !== 'Signature'));
        sort($keys, SORT_STRING);
        $message = '';
        foreach ($keys as $k) {
            $message .= $payload[$k];
        }

        return Crypto::toHex(Crypto::hmac('sha512', $secretKey, $message));
    }

    /**
     * Optional: list banks/wallets to show your own picker; pass the chosen InstrumentCode to initiate().
     */
    public function getInstruments(): mixed
    {
        $r = $this->call('GetPaymentInstrumentDetails', $this->merchant, 2);
        if ($r['code'] !== '0') {
            throw self::fail('GetPaymentInstrumentDetails', $r);
        }

        return $r['data'] ?? null;
    }

    /** Optional: NPS service charge for an amount + instrument. */
    public function getServiceCharge(int $amountPaisa, string $instrumentCode): mixed
    {
        $r = $this->call('GetServiceCharge', $this->merchant + ['Amount' => Money::paisaToRupees($amountPaisa), 'InstrumentCode' => $instrumentCode], 2);
        if ($r['code'] !== '0') {
            throw self::fail('GetServiceCharge', $r);
        }

        return $r['data'] ?? null;
    }

    /**
     * GetProcessId + gateway form (multipart/form-data). `providerRef` = ProcessId (persist it).
     * The Notification URL (webhook) is configured with NPS at onboarding, not per request.
     *
     * @param string|null $instrumentCode Skips NPS's picker page.
     */
    public function initiate(InitiateInput $input, ?string $instrumentCode = null): FormResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::Nps);
        $amount = Money::paisaToRupees($input->amountPaisa); // the SAME string in GetProcessId and the form
        $r = $this->call('GetProcessId', $this->merchant + ['Amount' => $amount, 'MerchantTxnId' => $input->orderId]);
        $processId = is_array($r['data'] ?? null) ? ($r['data']['ProcessId'] ?? null) : null;
        if ($r['code'] !== '0' || !Js::truthy($processId)) {
            throw self::fail('GetProcessId', $r);
        }
        $processId = Js::toString($processId);
        $fields = $this->merchant + [
            'Amount' => $amount,
            'MerchantTxnId' => $input->orderId,
            'ProcessId' => $processId,
            'TransactionRemarks' => Js::slice($input->description, 100),
            'ResponseUrl' => $input->returnUrl,
        ];
        if ($instrumentCode !== null && $instrumentCode !== '') {
            $fields['InstrumentCode'] = $instrumentCode;
        }

        return new FormResult($this->gateway, $fields, 'POST', 'multipart/form-data', $processId);
    }

    /** CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API error. */
    public function verify(VerifyInput $input): VerifyResult
    {
        $orderId = $input->orderId;
        $r = $this->call('CheckTransactionStatus', $this->merchant + ['MerchantTxnId' => $orderId], 2);
        if ($r['code'] !== '0') {
            // error_code "3" = "Transaction not initialized yet" (payer never reached the gateway)
            foreach (self::errors($r) as $e) {
                if (is_array($e) && ($e['error_code'] ?? null) === '3') {
                    return new VerifyResult(ProviderId::Nps, PaymentStatus::NotFound, $orderId, null, null, $r);
                }
            }
            throw self::fail('CheckTransactionStatus', $r);
        }
        $d = $r['data'] ?? null;
        if (!is_array($d)) {
            throw new PaymentException('NPS CheckTransactionStatus: response has no data', ProviderId::Nps, 'malformed_response', 200, $r);
        }
        if (Js::truthy($d['MerchantTxnId'] ?? null) && $d['MerchantTxnId'] !== $orderId) {
            throw new PaymentException('NPS: status is for a different transaction', ProviderId::Nps, 'callback_mismatch', 400, $d);
        }
        $amount = $d['Amount'] ?? null;

        return new VerifyResult(
            ProviderId::Nps,
            self::STATUS[strtolower(Js::toString($d['Status'] ?? ''))] ?? PaymentStatus::Unknown,
            $orderId,
            Js::truthy($amount) ? Money::rupeesToPaisa(is_int($amount) || is_float($amount) || is_string($amount) ? $amount : Js::toString($amount)) : null, // excludes ServiceCharge
            isset($d['GatewayReferenceNo']) ? Js::toString($d['GatewayReferenceNo']) : null,
            $r,
        );
    }

    public function orderIdFromCallback(array $params): ?string
    {
        return Js::firstTruthy(Js::stringMap($params)['MerchantTxnId'] ?? null);
    }

    /**
     * Body to return from your Notification URL handler AFTER you've verified + recorded the payment.
     * NPS expects plain text "received" the first time and "already received" for repeats.
     */
    public function notificationResponse(bool $alreadyProcessed): string
    {
        return $alreadyProcessed ? 'already received' : 'received';
    }

    /**
     * @param array<string, string> $payload
     * @return array<string, mixed>
     */
    private function call(string $path, array $payload, int $retries = 0): array
    {
        $body = $payload + ['Signature' => self::sign($this->cfg->secretKey, $payload)];
        $res = $this->http->request(
            ProviderId::Nps,
            "{$this->api}/{$path}",
            'POST',
            ['Authorization' => Crypto::basicAuth($this->cfg->apiUsername, $this->cfg->apiPassword)],
            $body,
            $this->cfg->timeoutMs,
            $retries,
        );
        if ($res->status === 401) {
            throw new PaymentException('NPS: 401 — wrong API username/password', ProviderId::Nps, 'unauthorized', 401);
        }
        if ($res->status !== 200 || !is_array($res->data) || !array_key_exists('code', $res->data)) {
            throw new PaymentException("NPS {$path} failed: " . Js::slice($res->text, 200), ProviderId::Nps, "http_{$res->status}", $res->status, $res->data);
        }

        return $res->data;
    }

    /** @param array<string, mixed> $r @return list<mixed> */
    private static function errors(array $r): array
    {
        $e = $r['errors'] ?? null;

        return is_array($e) && array_is_list($e) ? $e : [];
    }

    /** @param array<string, mixed> $r */
    private static function fail(string $path, array $r): PaymentException
    {
        $errors = self::errors($r);
        $msg = Js::join(array_map(static fn (mixed $e): mixed => is_array($e) ? ($e['error_message'] ?? null) : null, $errors), '; ');
        if ($msg === '') {
            $msg = array_key_exists('message', $r) ? Js::toString($r['message']) : 'undefined';
        }
        $first = $errors[0] ?? null;
        $code = is_array($first) && Js::truthy($first['error_code'] ?? null) ? 'nps_' . Js::toString($first['error_code']) : 'nps_error';

        return new PaymentException("NPS {$path}: {$msg}", ProviderId::Nps, $code, 200, $r);
    }
}
