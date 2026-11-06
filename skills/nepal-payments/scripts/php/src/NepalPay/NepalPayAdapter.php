<?php

declare(strict_types=1);

namespace NepalPayments\NepalPay;

use NepalPayments\Crypto;
use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\QrResult;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * NEPALPAY QR (NCHL) merchant dynamic QR: https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
 * Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI username/password,
 * and the signing .pfx (NPI.pfx in UAT).
 *
 * Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qrString / qrImage -> customer scans with any
 *       NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= providerRef).
 *
 * Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
 * Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
 */
final class NepalPayAdapter implements PaymentAdapter
{
    private const BASE = ['sandbox' => 'https://devopennpi.connectips.com', 'production' => 'https://opennpi.connectips.com'];
    private const NPR = 524;
    private const CREDIT_OK = ['000', '999', 'DEFER'];

    private readonly string $base;
    /** @var array{token: string, until: float}|null OAuth bearer token, `until` in epoch ms. */
    private ?array $cached = null;

    public function __construct(
        private readonly NepalPayConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->base = $cfg->baseUrl ?? self::BASE[$cfg->env->value];
    }

    public function id(): ProviderId
    {
        return ProviderId::NepalPay;
    }

    /**
     * The exact string NCHL expects to be signed for a dynamic QR.
     *
     * @param array{acquirerId: string, merchantId: string, merchantCategoryCode: int|string, transactionCurrency: int|string, transactionAmount: string, billNumber: string, userId: string} $f
     */
    public static function tokenString(array $f): string
    {
        return implode(',', [
            $f['acquirerId'], $f['merchantId'], (string) $f['merchantCategoryCode'], (string) $f['transactionCurrency'],
            $f['transactionAmount'], $f['billNumber'], $f['userId'],
        ]);
    }

    /**
     * Dynamic QR. billNumber = orderId (<= 25 chars). Persist `providerRef` (validationTraceId): verify() needs it.
     * returnUrl is unused: there is no redirect, the payer scans the QR from their own app.
     */
    public function initiate(InitiateInput $input): QrResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::NepalPay);
        if (preg_match('/^[A-Za-z0-9-]{1,25}\z/', $input->orderId) !== 1) {
            throw new PaymentException('NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]', ProviderId::NepalPay, 'invalid_order_id');
        }
        $transactionAmount = Money::paisaToRupees2dp($input->amountPaisa); // always 2 decimals
        $token = Crypto::rsaSha256SignBase64($this->cfg->privateKeyPem, self::tokenString([
            'acquirerId' => $this->cfg->acquirerId,
            'merchantId' => $this->cfg->merchantId,
            'merchantCategoryCode' => $this->cfg->merchantCategoryCode,
            'transactionCurrency' => self::NPR,
            'transactionAmount' => $transactionAmount,
            'billNumber' => $input->orderId,
            'userId' => $this->cfg->username,
        ]));
        $body = [
            'pointOfInitialization' => 12,
            'acquirerId' => $this->cfg->acquirerId,
            'merchantId' => $this->cfg->merchantId,
            'merchantName' => Js::slice($this->cfg->merchantName, 25),
            'merchantCategoryCode' => self::number($this->cfg->merchantCategoryCode),
            'merchantCountry' => 'NP',
            'merchantCity' => $this->cfg->merchantCity,
            'merchantPostalCode' => $this->cfg->merchantPostalCode,
            'merchantLanguage' => 'en',
            'transactionCurrency' => self::NPR,
            'transactionAmount' => $transactionAmount,
            'valueOfConvenienceFeeFixed' => '0.00',
            'billNumber' => $input->orderId,
            'storeLabel' => $this->cfg->storeLabel,
            'terminalLabel' => $this->cfg->terminalLabel ?? '0',
            'purposeOfTransaction' => Js::slice(Js::firstTruthy($input->description) ?? 'Payment', 25),
            'qrImage' => $this->cfg->qrImage,
            'token' => $token,
        ];
        $res = $this->http->request(ProviderId::NepalPay, "{$this->base}/qr/generateQR", 'POST', ['Authorization' => $this->authHeader()], $body, $this->cfg->timeoutMs);
        $d = is_array($res->data) ? $res->data : [];
        $data = isset($d['data']) && is_array($d['data']) ? $d['data'] : [];
        if (($d['responseCode'] ?? null) !== '000' || !Js::truthy($data['qrString'] ?? null) || !Js::truthy($data['validationTraceId'] ?? null)) {
            $first = isset($d['responses']) && is_array($d['responses']) && isset($d['responses'][0]) && is_array($d['responses'][0]) ? $d['responses'][0] : [];
            $code = $d['responseCode'] ?? $first['responseCode'] ?? "http_{$res->status}";
            throw new PaymentException('NEPALPAY generateQR failed: ' . Js::slice($res->text, 300), ProviderId::NepalPay, Js::toString($code), $res->status, $res->data);
        }

        return new QrResult(
            Js::trim(Js::toString($data['qrString'])),
            Js::toString($data['validationTraceId']),
            Js::truthy($data['qrImage'] ?? null) ? Js::toString($data['qrImage']) : null,
            $res->data,
        );
    }

    /**
     * Every payment made against one QR (a failed scan can be retried on the same QR).
     *
     * @return list<array<string, mixed>> nQrTxnId, instructionId, amount, debitStatus, creditStatus, merchantBillNo, payerName, tranType, ...
     */
    public function report(string $validationTraceId): array
    {
        $body = ['validationTraceId' => $validationTraceId, 'merchantId' => $this->cfg->merchantId, 'acquirerId' => $this->cfg->acquirerId];
        $res = $this->http->request(ProviderId::NepalPay, "{$this->base}/nQR/v1/merchanttxnreport", 'POST', ['Authorization' => $this->authHeader()], $body, $this->cfg->timeoutMs, 2);
        if ($res->status === 401) {
            throw new PaymentException('NEPALPAY: 401 — wrong NPI username/password', ProviderId::NepalPay, 'unauthorized', 401, $res->data);
        }
        $d = is_array($res->data) ? $res->data : [];
        $code = isset($d['responseCode']) ? Js::toString($d['responseCode']) : '';
        if ($code === 'E010') {
            return []; // record not found
        }
        if ($code !== '200' && $code !== '000') {
            throw new PaymentException('NEPALPAY report failed: ' . Js::slice($res->text, 200), ProviderId::NepalPay, $code !== '' ? $code : "http_{$res->status}", $res->status, $res->data);
        }
        $rows = $d['responseBody'] ?? null;

        return is_array($rows) && array_is_list($rows) ? array_values(array_filter($rows, 'is_array')) : [];
    }

    /** merchanttxnreport by validationTraceId, authoritative. */
    public function verify(VerifyInput $input): VerifyResult
    {
        if (!Js::truthy($input->providerRef)) {
            throw new PaymentException('NEPALPAY verify needs providerRef (validationTraceId)', ProviderId::NepalPay, 'missing_provider_ref');
        }
        $txns = $this->report((string) $input->providerRef);
        $payments = array_values(array_filter($txns, static fn (array $t): bool => ($t['tranType'] ?? 'PMT') === 'PMT'));
        $paid = null;
        foreach ($payments as $t) {
            if (($t['debitStatus'] ?? null) === '000' && array_key_exists('creditStatus', $t) && in_array(Js::toString($t['creditStatus']), self::CREDIT_OK, true)) {
                $paid = $t;
                break;
            }
        }
        $pick = $paid ?? ($payments === [] ? null : $payments[count($payments) - 1]);
        $status = match (true) {
            $paid !== null => PaymentStatus::Paid,
            $pick === null => PaymentStatus::NotFound,
            ($pick['debitStatus'] ?? null) === '000' => PaymentStatus::Unknown, // debited but credit not confirmed: review
            default => PaymentStatus::Failed,
        };
        $amount = $pick['amount'] ?? null;
        $amt = is_int($amount) || is_float($amount) || is_string($amount) ? Money::rupeesToPaisa($amount) : null;
        $txnId = isset($pick['nQrTxnId']) ? Js::toString($pick['nQrTxnId']) : null;

        return new VerifyResult(ProviderId::NepalPay, $status, $input->orderId, $amt, $txnId, $txns);
    }

    /** Your orderId from a confirm-payment notification (merchantBillNo = the billNumber you sent). */
    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);

        return Js::firstTruthy($p['merchantBillNo'] ?? null, $p['billNumber'] ?? null);
    }

    /**
     * What NCHL signs on a confirm-payment notification. The docs name the field payerMobileNumber; the sample
     * sends payerMobile. Null or missing fields count as "".
     *
     * @param array<string, mixed> $n
     */
    public static function confirmationString(array $n): string
    {
        $v = static fn (string $k): string => isset($n[$k]) ? Js::toString($n[$k]) : '';

        return implode(',', [
            $v('merchantBillNo'), $v('merchantId'), $v('merchantName'), $v('paymentRef'), $v('channel'),
            isset($n['payerMobileNumber']) ? $v('payerMobileNumber') : $v('payerMobile'), $v('sessionNo'),
        ]);
    }

    /**
     * Check a confirm-payment notification's signature with nchlPublicKeyPem. NCHL doesn't say which key signs it, so
     * a false here is a reason to log and alert, not proof of forgery. Fulfil only after verify() either way.
     *
     * @param array<string, mixed> $n
     * @throws \LogicException without nchlPublicKeyPem
     */
    public function verifyConfirmation(array $n): bool
    {
        if ($this->cfg->nchlPublicKeyPem === null) {
            throw new \LogicException('nepalpay: nchlPublicKeyPem required to verify notifications');
        }
        if (!isset($n['signature']) || !is_string($n['signature'])) {
            return false;
        }

        return Crypto::rsaSha256VerifyBase64($this->cfg->nchlPublicKeyPem, self::confirmationString($n), $n['signature']);
    }

    /**
     * Everything a STOMP client needs to watch one QR live: connect to `url`, subscribe to `subscribe`, then send
     * `body` as JSON to `send`. Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify().
     *
     * @return array{url: string, subscribe: string, send: string, body: array{merchant_id: string, request_id: string, username: string, api_token: string}}
     * @throws \LogicException without wsUrl, wsUsername, wsApiToken and nchlPublicKeyPem
     */
    public function webSocketRequest(string $validationTraceId): array
    {
        $c = $this->cfg;
        if ($c->wsUrl === null || $c->wsUsername === null || $c->wsApiToken === null || $c->nchlPublicKeyPem === null) {
            throw new \LogicException('nepalpay: wsUrl, wsUsername, wsApiToken and nchlPublicKeyPem required for the WebSocket channel');
        }

        return [
            'url' => $c->wsUrl,
            'subscribe' => '/user/nqrws/check-txn-status',
            'send' => '/nqrws/check-txn-status',
            'body' => [
                'merchant_id' => $c->terminalLabel ?? '0',
                'request_id' => $validationTraceId,
                'username' => $c->wsUsername,
                'api_token' => Crypto::rsaPkcs1EncryptBase64($c->nchlPublicKeyPem, $c->wsApiToken),
            ],
        ];
    }

    /**
     * Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.
     * The notification is a hint: call verify() before fulfilling.
     *
     * @return array{txnDate: string, status: string, message: string, merchantBillNo: string, paymentRef: string, signature: string}
     */
    public function confirmationResponse(string $txnDate, string $merchantBillNo, string $paymentRef, bool $ok = true): array
    {
        $status = $ok ? 'SUCCESS' : 'FAILED';
        $message = $ok ? 'TRANSACTION SUCCESSFUL' : 'TRANSACTION FAILED';
        $tokenString = implode(',', [$txnDate, $status, $message, $merchantBillNo, $paymentRef]);

        return [
            'txnDate' => $txnDate,
            'status' => $status,
            'message' => $message,
            'merchantBillNo' => $merchantBillNo,
            'paymentRef' => $paymentRef,
            'signature' => Crypto::rsaSha256SignBase64($this->cfg->privateKeyPem, $tokenString),
        ];
    }

    private function authHeader(): string
    {
        if ($this->cfg->auth === 'basic') {
            return Crypto::basicAuth($this->cfg->username, $this->cfg->password);
        }
        if (!Js::truthy($this->cfg->clientId) || !Js::truthy($this->cfg->clientSecret)) {
            throw new \LogicException('nepalpay: clientId/clientSecret required for auth "oauth"');
        }
        $now = microtime(true) * 1000;
        if ($this->cached !== null && $this->cached['until'] > $now) {
            return "Bearer {$this->cached['token']}";
        }
        $body = Js::urlSearchParams(['grant_type' => 'password', 'username' => $this->cfg->username, 'password' => $this->cfg->password]);
        $res = $this->http->request(
            ProviderId::NepalPay,
            "{$this->base}/oauth/token",
            'POST',
            ['Authorization' => Crypto::basicAuth((string) $this->cfg->clientId, (string) $this->cfg->clientSecret), 'Content-Type' => 'application/x-www-form-urlencoded'],
            $body,
            $this->cfg->timeoutMs,
        );
        $d = is_array($res->data) ? $res->data : [];
        if ($res->status !== 200 || !Js::truthy($d['access_token'] ?? null)) {
            throw new PaymentException('NEPALPAY oauth failed: ' . Js::slice($res->text, 200), ProviderId::NepalPay, 'unauthorized', $res->status, $res->data);
        }
        // Number(expires_in) || 60
        $ttl = array_key_exists('expires_in', $d) ? Js::toNumber($d['expires_in']) : NAN;
        if (is_nan($ttl) || $ttl === 0.0) {
            $ttl = 60.0;
        }
        $this->cached = ['token' => Js::toString($d['access_token']), 'until' => microtime(true) * 1000 + max($ttl - 30, 5) * 1000];

        return "Bearer {$this->cached['token']}";
    }

    /** JS `Number(v)` as a JSON value: integral -> int, NaN/Infinity -> null (JSON.stringify writes null). */
    private static function number(int|string $v): int|float|null
    {
        if (is_int($v)) {
            return $v;
        }
        $n = Js::toNumber($v);
        if (!is_finite($n)) {
            return null;
        }

        return floor($n) === $n && abs($n) < 9.0E15 ? (int) $n : $n;
    }
}
