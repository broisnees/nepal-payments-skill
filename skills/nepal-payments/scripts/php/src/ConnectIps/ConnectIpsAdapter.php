<?php

declare(strict_types=1);

namespace NepalPayments\ConnectIps;

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
 * connectIPS (NCHL) e-payment gateway — https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
 *
 * Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to loginpage
 *       -> connectIPS redirects to your registered success/failure URL with ?TXNID=... -> validatetxn (Basic auth).
 */
final class ConnectIpsAdapter implements PaymentAdapter
{
    private const BASE = ['sandbox' => 'https://uat.connectips.com', 'production' => 'https://login.connectips.com'];

    private readonly string $base;
    /** @var array<string, string> */
    private readonly array $auth;

    public function __construct(
        private readonly ConnectIpsConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->base = $cfg->baseUrl ?? self::BASE[$cfg->env->value];
        $this->auth = ['Authorization' => Crypto::basicAuth($cfg->appId, $cfg->appPassword)];
    }

    public function id(): ProviderId
    {
        return ProviderId::ConnectIps;
    }

    /** DD-MM-YYYY in Asia/Kathmandu. */
    public static function date(?\DateTimeInterface $at = null): string
    {
        $d = \DateTimeImmutable::createFromInterface($at ?? new \DateTimeImmutable('now'));

        return $d->setTimezone(new \DateTimeZone('Asia/Kathmandu'))->format('d-m-Y');
    }

    /** The exact string connectIPS expects to be signed for the gateway form. @param array<string, string> $f */
    public static function tokenString(array $f): string
    {
        $g = static fn (string $k): string => $f[$k] ?? '';

        return "MERCHANTID={$g('MERCHANTID')},APPID={$g('APPID')},APPNAME={$g('APPNAME')},TXNID={$g('TXNID')},TXNDATE={$g('TXNDATE')},"
            . "TXNCRNCY={$g('TXNCRNCY')},TXNAMT={$g('TXNAMT')},REFERENCEID={$g('REFERENCEID')},REMARKS={$g('REMARKS')},"
            . "PARTICULARS={$g('PARTICULARS')},TOKEN=TOKEN";
    }

    /**
     * Form POST to the connectIPS login page. TXNID = orderId (<= 20 chars, unique per app). Amount in PAISA.
     * Success/failure redirect URLs are REGISTERED WITH NCHL, not sent per request; returnUrl is unused here.
     */
    public function initiate(InitiateInput $input, ?string $referenceId = null, ?string $remarks = null, ?string $particulars = null): FormResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::ConnectIps);
        if (preg_match('/^[A-Za-z0-9-]{1,20}\z/', $input->orderId) !== 1) {
            throw new PaymentException('connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]', ProviderId::ConnectIps, 'invalid_order_id');
        }
        $rem = self::clip($remarks ?? $input->description, 50);
        $par = self::clip($particulars ?? $input->description, 100);
        $f = [
            'MERCHANTID' => (string) $this->cfg->merchantId,
            'APPID' => $this->cfg->appId,
            'APPNAME' => Js::slice($this->cfg->appName, 30),
            'TXNID' => $input->orderId,
            'TXNDATE' => self::date(),
            'TXNCRNCY' => 'NPR',
            'TXNAMT' => (string) $input->amountPaisa, // PAISA
            'REFERENCEID' => self::clip($referenceId ?? $input->orderId, 20),
            'REMARKS' => $rem !== '' ? $rem : 'Payment',
            'PARTICULARS' => $par !== '' ? $par : 'Payment',
        ];
        $f['TOKEN'] = Crypto::rsaSha256SignBase64($this->cfg->privateKeyPem, self::tokenString($f));

        return new FormResult("{$this->base}/connectipswebgw/loginpage", $f);
    }

    /** validatetxn — authoritative. SUCCESS + amount match = paid. */
    public function verify(VerifyInput $input): VerifyResult
    {
        $r = $this->validationCall('validatetxn', $input->orderId, $input->amountPaisa);
        $desc = strtoupper(isset($r['statusDesc']) ? Js::toString($r['statusDesc']) : '');
        $status = match (true) {
            $r['status'] === 'SUCCESS' => PaymentStatus::Paid,
            $r['status'] === 'FAILED' => PaymentStatus::Failed,
            str_contains($desc, 'NOT FOUND') => PaymentStatus::NotFound,
            str_contains($desc, 'INCOMPLETE') => PaymentStatus::Pending, // user hasn't finished OTP yet
            default => PaymentStatus::Unknown,
        };
        // Math.round(Number(txnAmt)); null when absent or not a finite number.
        $amt = array_key_exists('txnAmt', $r) ? Js::roundToInt(Js::toNumber($r['txnAmt'])) : null;

        return new VerifyResult(ProviderId::ConnectIps, $status, $input->orderId, $amt, null, $r);
    }

    /**
     * Full detail incl. NCHL txnId, bank, charges and creditStatus ("000"/"999"/"DEFER" = credited/OK).
     *
     * @return array<string, mixed>
     */
    public function getTxnDetail(string $orderId, int $amountPaisa): array
    {
        return $this->validationCall('gettxndetail', $orderId, $amountPaisa);
    }

    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);

        return Js::firstTruthy($p['TXNID'] ?? null, $p['txnId'] ?? null);
    }

    /** @return array<string, mixed> */
    private function validationCall(string $path, string $txnId, int $amountPaisa): array
    {
        $tokenString = "MERCHANTID={$this->cfg->merchantId},APPID={$this->cfg->appId},REFERENCEID={$txnId},TXNAMT={$amountPaisa}";
        $mid = is_int($this->cfg->merchantId) ? $this->cfg->merchantId : Js::toNumber($this->cfg->merchantId);
        $body = [
            'merchantId' => is_float($mid) ? (is_finite($mid) ? (floor($mid) === $mid && abs($mid) < 9.0E15 ? (int) $mid : $mid) : null) : $mid,
            'appId' => $this->cfg->appId,
            'referenceId' => $txnId, // NOTE: the TXNID you sent, not REFERENCEID
            'txnAmt' => $amountPaisa,
            'token' => Crypto::rsaSha256SignBase64($this->cfg->privateKeyPem, $tokenString),
        ];
        $res = $this->http->request(ProviderId::ConnectIps, "{$this->base}/connectipswebws/api/creditor/{$path}", 'POST', $this->auth, $body, $this->cfg->timeoutMs, 2);
        if ($res->status === 401) {
            throw new PaymentException('connectIPS: 401 — wrong APPID/app password', ProviderId::ConnectIps, 'unauthorized', 401);
        }
        if ($res->status !== 200 || !is_array($res->data) || !Js::truthy($res->data['status'] ?? null)) {
            throw new PaymentException("connectIPS {$path} failed: " . Js::slice($res->text, 200), ProviderId::ConnectIps, "http_{$res->status}", $res->status, $res->data);
        }

        return $res->data;
    }

    /** Commas/equals would corrupt the token string. */
    private static function clip(string $s, int $n): string
    {
        return Js::slice(strtr($s, ',=', '  '), $n);
    }
}
