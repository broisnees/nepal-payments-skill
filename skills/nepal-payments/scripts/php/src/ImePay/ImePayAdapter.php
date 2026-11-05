<?php

declare(strict_types=1);

namespace NepalPayments\ImePay;

use NepalPayments\Crypto;
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
 * IME Pay web checkout (official WooCommerce/WHMCS plugin flow). IME Pay merged into Khalti ("Khalti by IME",
 * July 2025): prefer Khalti for new builds.
 *
 * Auth: Basic base64(username:password) + header `Module: base64(moduleName)`. Callbacks are UNSIGNED, so
 * Recheck is the only proof of payment. Port 7979 must be reachable outbound.
 */
final class ImePayAdapter implements PaymentAdapter
{
    private const BASE = ['sandbox' => 'https://stg.imepay.com.np:7979', 'production' => 'https://payment.imepay.com.np:7979'];

    private readonly string $base;
    /** @var array<string, string> */
    private readonly array $headers;

    public function __construct(
        private readonly ImePayConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->base = $cfg->baseUrl ?? self::BASE[$cfg->env->value];
        $this->headers = ['Authorization' => Crypto::basicAuth($cfg->username, $cfg->password), 'Module' => Crypto::toBase64($cfg->module)];
    }

    public function id(): ProviderId
    {
        return ProviderId::ImePay;
    }

    /**
     * GetToken -> redirect to WebCheckout with base64 payload. IME POSTs the result (ResponseCode, RefId,
     * TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl. `providerRef` = TokenId (persist it).
     */
    public function initiate(InitiateInput $input): RedirectResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::ImePay);
        $amount = Money::paisaToRupees2dp($input->amountPaisa); // "100.00"
        $res = $this->http->request(
            ProviderId::ImePay,
            "{$this->base}/api/Web/GetToken",
            'POST',
            $this->headers,
            ['MerchantCode' => $this->cfg->merchantCode, 'Amount' => $amount, 'RefId' => $input->orderId],
            $this->cfg->timeoutMs,
        );
        $d = is_array($res->data) ? $res->data : [];
        $code = array_key_exists('ResponseCode', $d) ? Js::toString($d['ResponseCode']) : 'undefined';
        if ($res->status !== 200 || !Js::truthy($d['TokenId'] ?? null) || $code !== '0') {
            $desc = isset($d['ResponseDescription']) ? Js::toString($d['ResponseDescription']) : Js::slice($res->text, 200);
            $suffix = isset($d['ResponseCode']) ? Js::toString($d['ResponseCode']) : (string) $res->status;
            throw new PaymentException("IME Pay GetToken failed: {$desc}", ProviderId::ImePay, "imepay_{$suffix}", $res->status, $res->data);
        }
        $token = Js::toString($d['TokenId']);
        $payload = implode('|', [$token, $this->cfg->merchantCode, $input->orderId, $amount, 'POST', $input->returnUrl, $input->failureUrl ?? $input->returnUrl]);

        return new RedirectResult(
            "{$this->base}/WebCheckout/Checkout?data=" . Js::encodeURIComponent(Crypto::toBase64($payload)),
            $token,
            null,
            $res->data,
        );
    }

    /** Recheck — authoritative. ResponseCode 0 = paid. Other codes are inconsistently documented: treated as pending. */
    public function verify(VerifyInput $input): VerifyResult
    {
        $orderId = $input->orderId;
        if ($input->providerRef === null || $input->providerRef === '') {
            throw new PaymentException('IME Pay: stored TokenId required for verify', ProviderId::ImePay, 'missing_token');
        }
        $res = $this->http->request(
            ProviderId::ImePay,
            "{$this->base}/api/Web/Recheck",
            'POST',
            $this->headers,
            ['MerchantCode' => $this->cfg->merchantCode, 'RefId' => $orderId, 'TokenId' => $input->providerRef],
            $this->cfg->timeoutMs,
            2,
        );
        if ($res->status !== 200 || !is_array($res->data) || !array_key_exists('ResponseCode', $res->data)) {
            throw new PaymentException('IME Pay Recheck failed: ' . Js::slice($res->text, 200), ProviderId::ImePay, "http_{$res->status}", $res->status, $res->data);
        }
        $d = $res->data;
        if (Js::truthy($d['RefId'] ?? null) && $d['RefId'] !== $orderId) {
            throw new PaymentException('IME Pay: Recheck is for a different RefId', ProviderId::ImePay, 'callback_mismatch', 400, $d);
        }
        $paid = Js::toString($d['ResponseCode']) === '0';
        $tran = $d['TranAmount'] ?? null;

        return new VerifyResult(
            ProviderId::ImePay,
            // Non-zero codes disagree across sources (1 = failed vs pending), so never mark failed from them;
            // the reconciliation job escalates the attempt for human review at its cutoff.
            $paid ? PaymentStatus::Paid : PaymentStatus::Pending,
            $orderId,
            $tran !== null && $tran !== '' ? Money::rupeesToPaisa(is_int($tran) || is_float($tran) || is_string($tran) ? $tran : Js::toString($tran)) : null,
            Js::truthy($d['TransactionId'] ?? null) ? Js::toString($d['TransactionId']) : null,
            $d,
        );
    }

    public function orderIdFromCallback(array $params): ?string
    {
        return Js::firstTruthy(Js::stringMap($params)['RefId'] ?? null);
    }
}
