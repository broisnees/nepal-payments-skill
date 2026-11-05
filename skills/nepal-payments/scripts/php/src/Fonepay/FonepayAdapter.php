<?php

declare(strict_types=1);

namespace NepalPayments\Fonepay;

use NepalPayments\Crypto;
use NepalPayments\Environment;
use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Internal\Json;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\RedirectResult;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * Fonepay — Web payment (redirect) + Dynamic QR.
 *
 * Signatures: HMAC-SHA512(secretKey, comma-joined values) as HEX. Compare case-insensitively.
 *   request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
 *   response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
 *   txnVerification  = username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>
 *   QR create        = amount,prn,merchantCode,remarks1,remarks2
 *   QR status        = prn,merchantCode
 */
final class FonepayAdapter implements PaymentAdapter
{
    private const URLS = [
        'sandbox' => [
            'payment' => 'https://dev-clientapi.fonepay.com/api/merchantRequest',
            'legacyVerify' => 'https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant',
            // Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on onboarding).
            'txnVerification' => 'https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification',
            'qrBase' => 'https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty',
        ],
        'production' => [
            'payment' => 'https://clientapi.fonepay.com/api/merchantRequest',
            'legacyVerify' => 'https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant',
            'txnVerification' => 'https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification',
            'qrBase' => 'https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty',
        ],
    ];

    private const TXN_STATUS = ['success' => PaymentStatus::Paid, 'pending' => PaymentStatus::Pending, 'failed' => PaymentStatus::Failed];
    private const TXN_RESOURCE = '/merchant/merchantDetailsForThirdParty/txnVerification';
    public const RESPONSE_DV_FIELDS = ['PRN', 'PID', 'PS', 'RC', 'UID', 'BC', 'INI', 'P_AMT', 'R_AMT'];

    /** @var array{payment: string, legacyVerify: string, txnVerification: string, qrBase: string} */
    private readonly array $urls;

    public function __construct(
        private readonly FonepayConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $u = self::URLS[$cfg->env->value];
        $this->urls = [
            'payment' => $cfg->paymentUrl ?? $u['payment'],
            'legacyVerify' => $cfg->legacyVerifyUrl ?? $u['legacyVerify'],
            'txnVerification' => $cfg->txnVerificationUrl ?? $u['txnVerification'],
            'qrBase' => $cfg->qrBaseUrl ?? $u['qrBase'],
        ];
    }

    public function id(): ProviderId
    {
        return ProviderId::Fonepay;
    }

    /** Uppercase hex HMAC-SHA512 over comma-joined values. @param list<string|int> $values */
    public static function hmac(string $secret, array $values): string
    {
        return strtoupper(Crypto::toHex(Crypto::hmac('sha512', $secret, Js::join($values, ','))));
    }

    /** MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats). */
    public static function date(?\DateTimeInterface $at = null): string
    {
        $d = \DateTimeImmutable::createFromInterface($at ?? new \DateTimeImmutable('now'));

        return $d->setTimezone(new \DateTimeZone('Asia/Kathmandu'))->format('m/d/Y');
    }

    /**
     * Redirect URL for the Fonepay web payment page. PRN = orderId (3–25 chars).
     * Keep returnUrl (RU) <= 150 chars and free of query strings.
     */
    public function initiate(InitiateInput $input, ?string $remarks2 = null): RedirectResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::Fonepay);
        $len = Js::length($input->orderId);
        if ($len < 3 || $len > 25) {
            throw new PaymentException('Fonepay PRN must be 3–25 chars', ProviderId::Fonepay, 'invalid_order_id');
        }
        if (Js::length($input->returnUrl) > 150) {
            throw new PaymentException('Fonepay RU must be <= 150 chars', ProviderId::Fonepay, 'invalid_return_url');
        }
        $r1 = Js::slice($input->description, 160);
        $r2 = Js::slice($remarks2 ?? 'N/A', 50);
        $p = [
            'PID' => $this->cfg->merchantCode,
            'MD' => 'P',
            'PRN' => $input->orderId,
            'AMT' => Money::paisaToRupees($input->amountPaisa), // rupees; the SAME string goes into DV
            'CRN' => 'NPR',
            'DT' => self::date(),
            'R1' => $r1 !== '' ? $r1 : 'Payment',
            'R2' => $r2 !== '' ? $r2 : 'N/A',
            'RU' => $input->returnUrl,
        ];
        $p['DV'] = self::hmac($this->cfg->secretKey, array_values($p)); // raw (not URL-encoded) values, in field order

        return new RedirectResult($this->urls['payment'] . '?' . Js::urlSearchParams($p));
    }

    /**
     * Verify the response DV on the return-URL params. A missing DV is invalid. Compared case-insensitively.
     *
     * @param array<array-key, mixed> $params
     */
    public function callbackValid(array $params): bool
    {
        $p = Js::stringMap($params);
        if (($p['DV'] ?? '') === '') {
            return false;
        }
        $expected = self::hmac($this->cfg->secretKey, array_map(static fn (string $f): string => $p[$f] ?? '', self::RESPONSE_DV_FIELDS));

        return Crypto::safeEqual($expected, strtoupper($p['DV']));
    }

    /**
     * Authoritative check. Uses txnVerification when username/password are configured (works without a callback,
     * so the reconciliation job can use it). Otherwise falls back to the legacy GET verification, which needs UID + BC
     * from a DV-verified redirect.
     */
    public function verify(VerifyInput $input): VerifyResult
    {
        $orderId = $input->orderId;
        $callback = $input->callback;
        // Callback params are trusted ONLY with a valid DV. A missing DV is treated exactly like a bad one,
        // otherwise anyone could send ?PRN=<id>&PS=false without a DV and force a "failed" outcome.
        $trusted = null;
        if ($callback !== null && array_intersect(array_keys($callback), ['DV', ...self::RESPONSE_DV_FIELDS]) !== []) {
            if ($this->callbackValid($callback)) {
                if (($callback['PRN'] ?? null) !== $orderId || ($callback['PID'] ?? null) !== $this->cfg->merchantCode) {
                    throw new PaymentException('Fonepay: callback does not match this attempt', ProviderId::Fonepay, 'callback_mismatch', 400, $callback);
                }
                $trusted = $callback;
            } elseif ($this->cfg->strictSignature) {
                throw new PaymentException('Fonepay: missing or invalid response DV', ProviderId::Fonepay, 'invalid_signature', 400, $callback);
            }
        }

        if ($this->hasLogin()) {
            $r = $this->txnVerification($orderId, $input->amountPaisa);
            $trace = $r['fonepayTraceId'] ?? null;

            return new VerifyResult(
                ProviderId::Fonepay,
                self::TXN_STATUS[strtolower($r['paymentStatus'])] ?? PaymentStatus::Unknown,
                $orderId,
                Js::truthy($r['requestedAmount'] ?? null) ? Money::rupeesToPaisa(self::amountValue($r['requestedAmount'])) : null,
                $trace !== null ? Js::toString($trace) : ($trusted['UID'] ?? null),
                $r,
            );
        }

        if ($trusted !== null && ($trusted['UID'] ?? '') !== '' && ($trusted['BC'] ?? '') !== '') {
            // Authentic (DV-verified) negative outcome from Fonepay.
            if (($trusted['PS'] ?? null) !== 'true' || ($trusted['RC'] ?? null) !== 'successful') {
                $status = ($trusted['RC'] ?? null) === 'cancel' ? PaymentStatus::Canceled : PaymentStatus::Failed;

                return new VerifyResult(ProviderId::Fonepay, $status, $orderId, null, $trusted['UID'], $trusted);
            }
            $text = $this->legacyVerify($orderId, $input->amountPaisa, $trusted['UID'], $trusted['BC'], $ok);

            return new VerifyResult(
                ProviderId::Fonepay,
                $ok ? PaymentStatus::Paid : PaymentStatus::Failed,
                $orderId,
                ($trusted['R_AMT'] ?? '') !== '' ? Money::rupeesToPaisa($trusted['R_AMT']) : null, // R_AMT = amount requested by merchant (DV-signed)
                $trusted['UID'],
                ['callback' => $trusted, 'verification' => $text],
            );
        }

        throw new PaymentException(
            'Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured for txnVerification',
            ProviderId::Fonepay,
            'verify_unavailable',
        );
    }

    public function orderIdFromCallback(array $params): ?string
    {
        return Js::firstTruthy(Js::stringMap($params)['PRN'] ?? null);
    }

    // ------------------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

    /** Create a dynamic QR. Render `qrMessage` as a QR code; listen on `webSocketUrl` or poll qrStatus(). */
    public function qrCreate(string $orderId, int $amountPaisa, string $remarks1, ?string $remarks2 = null): FonepayQr
    {
        $this->requireLogin('Dynamic QR');
        Money::assertPaisa($amountPaisa, ProviderId::Fonepay);
        $amount = Money::paisaToRupees($amountPaisa);
        $remarks2 ??= 'N/A';
        $body = [
            'amount' => $amount,
            'remarks1' => $remarks1,
            'remarks2' => $remarks2,
            'prn' => $orderId,
            'merchantCode' => $this->cfg->merchantCode,
            'dataValidation' => strtolower(self::hmac($this->cfg->secretKey, [$amount, $orderId, $this->cfg->merchantCode, $remarks1, $remarks2])),
            'username' => $this->cfg->username,
            'password' => $this->cfg->password,
        ];
        $res = $this->http->request(ProviderId::Fonepay, "{$this->urls['qrBase']}/thirdPartyDynamicQrDownload", 'POST', [], $body, $this->cfg->timeoutMs);
        if (!is_array($res->data) || !Js::truthy($res->data['qrMessage'] ?? null)) {
            $msg = is_array($res->data) && isset($res->data['message']) ? Js::toString($res->data['message']) : Js::slice($res->text, 200);
            throw new PaymentException("Fonepay QR create failed: {$msg}", ProviderId::Fonepay, "http_{$res->status}", $res->status, $res->data);
        }
        $ws = $res->data['thirdpartyQrWebSocketUrl'] ?? null;
        $ws = is_string($ws) ? $ws : null;
        // Fonepay has been seen returning a localhost host here; rewrite to the real socket host.
        if ($ws !== null && str_contains($ws, 'localhost')) {
            $host = $this->cfg->env === Environment::Production ? 'wss://ws.fonepay.com' : 'wss://dev-ws.fonepay.com';
            $ws = (string) preg_replace('~^wss?://[^/]+~', $host, $ws);
        }

        return new FonepayQr(Js::toString($res->data['qrMessage']), $ws, $res->data);
    }

    /**
     * Poll QR payment status. Always call this after a websocket "paymentSuccess" message before fulfilling.
     * Pass the stored amount: the status response has none, but the QR was created server-side with it.
     */
    public function qrStatus(string $orderId, ?int $amountPaisa = null): VerifyResult
    {
        $this->requireLogin('Dynamic QR');
        $body = [
            'prn' => $orderId,
            'merchantCode' => $this->cfg->merchantCode,
            'dataValidation' => strtolower(self::hmac($this->cfg->secretKey, [$orderId, $this->cfg->merchantCode])),
            'username' => $this->cfg->username,
            'password' => $this->cfg->password,
        ];
        $res = $this->http->request(ProviderId::Fonepay, "{$this->urls['qrBase']}/thirdPartyDynamicQrGetStatus", 'POST', [], $body, $this->cfg->timeoutMs, 2);
        if (!is_array($res->data) || !is_string($res->data['paymentStatus'] ?? null)) {
            throw new PaymentException('Fonepay QR status failed: ' . Js::slice($res->text, 200), ProviderId::Fonepay, "http_{$res->status}", $res->status, $res->data);
        }
        $trace = $res->data['fonepayTraceId'] ?? null;

        return new VerifyResult(
            ProviderId::Fonepay,
            self::TXN_STATUS[strtolower($res->data['paymentStatus'])] ?? PaymentStatus::Unknown,
            $orderId,
            $amountPaisa,
            $trace !== null ? Js::toString($trace) : null,
            $res->data,
        );
    }

    /** @return array<string, mixed> */
    private function txnVerification(string $prn, int $amountPaisa): array
    {
        $this->requireLogin('txnVerification');
        $username = (string) $this->cfg->username;
        $password = (string) $this->cfg->password;
        // Body is signed byte-for-byte; build it once and send exactly that string (format follows the spec example).
        $body = '{"prn": ' . Json::encode($prn) . ',"merchantCode": ' . Json::encode($this->cfg->merchantCode)
            . ',"amount": ' . Json::encode(Money::paisaToRupees($amountPaisa)) . '}';
        $auth = Crypto::toHex(Crypto::hmac('sha512', $this->cfg->secretKey, implode(',', [$username, $password, 'POST', 'application/json', self::TXN_RESOURCE, $body])));
        $res = $this->http->request(
            ProviderId::Fonepay,
            $this->urls['txnVerification'],
            'POST',
            ['Authorization' => Crypto::basicAuth($username, $password), 'auth' => $auth, 'Content-Type' => 'application/json'],
            $body,
            $this->cfg->timeoutMs,
            2,
        );
        if ($res->status !== 200 || !is_array($res->data) || !is_string($res->data['paymentStatus'] ?? null)) {
            throw new PaymentException('Fonepay txnVerification failed: ' . Js::slice($res->text, 200), ProviderId::Fonepay, "http_{$res->status}", $res->status, $res->data);
        }

        return $res->data;
    }

    /** Legacy (2019) GET verification; needs UID + BC from the redirect. Returns the XML text; `$ok` = paid. */
    private function legacyVerify(string $prn, int $amountPaisa, string $uid, string $bankCode, ?bool &$ok): string
    {
        $amt = Money::paisaToRupees($amountPaisa);
        $dv = self::hmac($this->cfg->secretKey, [$this->cfg->merchantCode, $amt, $prn, $bankCode, $uid]);
        $qs = Js::urlSearchParams(['PRN' => $prn, 'PID' => $this->cfg->merchantCode, 'BID' => $bankCode, 'AMT' => $amt, 'UID' => $uid, 'DV' => $dv]);
        $res = $this->http->request(ProviderId::Fonepay, "{$this->urls['legacyVerify']}?{$qs}", 'GET', ['Accept' => 'application/xml'], null, $this->cfg->timeoutMs, 2);
        // A 5xx / WAF page / HTML must never read as "not paid": throw so the attempt stays open.
        if ($res->status !== 200) {
            throw new PaymentException("Fonepay verification HTTP {$res->status}", ProviderId::Fonepay, 'upstream_error', $res->status, Js::slice($res->text, 500));
        }
        $code = self::tag($res->text, 'response_code');
        if ($code === null) {
            throw new PaymentException('Fonepay verification: unparseable response', ProviderId::Fonepay, 'malformed_response', $res->status, Js::slice($res->text, 500));
        }
        $ok = $code === 'successful' && self::tag($res->text, 'success') === 'true';

        return $res->text;
    }

    /** First `<t>value</t>` (no XML parser: no entity expansion, no network). */
    private static function tag(string $xml, string $t): ?string
    {
        $q = preg_quote($t, '~');

        return preg_match("~<{$q}>([^<]*)</{$q}>~", $xml, $m) === 1 ? $m[1] : null;
    }

    private static function amountValue(mixed $v): string|int|float
    {
        return is_int($v) || is_float($v) || is_string($v) ? $v : Js::toString($v);
    }

    private function hasLogin(): bool
    {
        return ($this->cfg->username ?? '') !== '' && ($this->cfg->password ?? '') !== '';
    }

    private function requireLogin(string $feature): void
    {
        if (!$this->hasLogin()) {
            throw new \LogicException("fonepay: username/password required for {$feature}");
        }
    }
}
