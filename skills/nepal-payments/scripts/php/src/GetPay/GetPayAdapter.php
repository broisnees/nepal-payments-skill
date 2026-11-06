<?php

declare(strict_types=1);

namespace NepalPayments\GetPay;

use NepalPayments\Crypto;
use NepalPayments\Html;
use NepalPayments\Http\HttpClient;
use NepalPayments\InitiateInput;
use NepalPayments\Internal\Js;
use NepalPayments\Internal\Json;
use NepalPayments\Money;
use NepalPayments\PaymentAdapter;
use NepalPayments\PaymentException;
use NepalPayments\PaymentStatus;
use NepalPayments\ProviderId;
use NepalPayments\SdkResult;
use NepalPayments\VerifyInput;
use NepalPayments\VerifyResult;

/**
 * GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure): https://getpay.global/web-integration/
 * Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid, tid}), oprKey, insKey (blank when
 * operator-hosted), the bundle URL and the base URL.
 *
 * Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
 *   -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
 *   -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
 *   -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.
 *
 * merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
 * only counts when the token's oprSecret matches YOUR oprKey and data.clientId is YOUR orderId.
 */
final class GetPayAdapter implements PaymentAdapter
{
    private const BASE = [
        'sandbox' => 'https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions',
        'production' => 'https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions',
    ];
    private const BUNDLE = 'https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js';
    private const TXN_STATUS = [
        'SUCCESS' => PaymentStatus::Paid,
        'APPROVED' => PaymentStatus::Paid,
        'FAILED' => PaymentStatus::Failed,
        'FAILURE' => PaymentStatus::Failed,
        'DECLINED' => PaymentStatus::Failed,
        'PENDING' => PaymentStatus::Pending,
        'CANCELLED' => PaymentStatus::Canceled,
        'CANCELED' => PaymentStatus::Canceled,
    ];

    private readonly string $base;
    private readonly string $bundleUrl;
    private readonly string $origin;

    /** @throws \InvalidArgumentException when websiteDomain is not an absolute URL */
    public function __construct(
        private readonly GetPayConfig $cfg,
        private readonly HttpClient $http = new HttpClient(),
    ) {
        $this->base = (string) preg_replace('#/\z#', '', $cfg->baseUrl ?? self::BASE[$cfg->env->value]);
        $this->bundleUrl = $cfg->bundleUrl ?? self::BUNDLE;
        $this->origin = self::origin($cfg->websiteDomain);
    }

    public function id(): ProviderId
    {
        return ProviderId::GetPay;
    }

    /** base64(SHA-256(oprKey + transactionId)): the oprSecret GetPay puts in the return token. */
    public static function oprSecret(string $oprKey, string $transactionId): string
    {
        return Crypto::toBase64(Crypto::sha256($oprKey . $transactionId));
    }

    /**
     * Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret".
     *
     * @return array{id: string, oprSecret: string}|null
     */
    public static function decodeToken(string $token): ?array
    {
        try {
            $text = Crypto::fromBase64(Js::trim(str_replace(' ', '+', $token)));
        } catch (\InvalidArgumentException) {
            return null;
        }
        try {
            $j = Json::decode($text);
        } catch (\JsonException) {
            $i = strpos($text, ':');

            return $i !== false && $i > 0 && $i < strlen($text) - 1 ? ['id' => substr($text, 0, $i), 'oprSecret' => substr($text, $i + 1)] : null;
        }
        $id = is_array($j) ? $j['id'] ?? null : null;
        $secret = is_array($j) ? $j['oprSecret'] ?? null : null;

        return is_string($id) && is_string($secret) && $id !== '' && $secret !== '' ? ['id' => $id, 'oprSecret' => $secret] : null;
    }

    /**
     * Options for the browser SDK. clientRequestId = orderId. returnUrl / failureUrl must be on websiteDomain and must
     * serve returnPage() (the token can arrive in the #hash, which only the browser sees).
     *
     * @throws \InvalidArgumentException when a callback URL is not an absolute URL
     */
    public function initiate(InitiateInput $input, ?string $orderInformationUI = null, ?bool $allowBillingAddressFields = null): SdkResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::GetPay);
        if (preg_match('/^[A-Za-z0-9-]{1,50}\z/', $input->orderId) !== 1) {
            throw new PaymentException('GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]', ProviderId::GetPay, 'invalid_order_id');
        }
        $failUrl = $input->failureUrl ?? $input->returnUrl;
        foreach ([$input->returnUrl, $failUrl] as $u) {
            if (self::origin($u) !== $this->origin) {
                throw new PaymentException("GetPay callback {$u} must be on websiteDomain {$this->origin}", ProviderId::GetPay, 'invalid_callback_url');
            }
        }
        $name = $input->customer?->name;
        $email = $input->customer?->email;
        $currency = $this->cfg->currency ?? 'NPR';

        return new SdkResult($this->bundleUrl, [
            'clientRequestId' => $input->orderId,
            'papInfo' => $this->cfg->papInfo,
            'oprKey' => $this->cfg->oprKey,
            'insKey' => $this->cfg->insKey ?? '',
            'websiteDomain' => $this->origin,
            'baseUrl' => $this->base,
            'price' => $input->amountPaisa / 100, // GetPay wants a number, not a string
            'currency' => $currency,
            'businessName' => $this->cfg->businessName,
            'imageUrl' => $this->cfg->imageUrl,
            'themeColor' => $this->cfg->themeColor ?? '#5662FF',
            'allowBillingAddressFields' => $allowBillingAddressFields ?? true,
            'userInfo' => ['name' => $name ?? '', 'email' => $email ?? '', 'state' => '', 'country' => '', 'zipcode' => '', 'city' => '', 'address' => ''],
            'prefill' => ['name' => Js::truthy($name), 'email' => Js::truthy($email), 'state' => false, 'city' => false, 'address' => false, 'zipcode' => false, 'country' => false],
            'disableFields' => new \stdClass(),
            'callbackUrl' => ['successUrl' => $input->returnUrl, 'failUrl' => $failUrl],
            'orderInformationUI' => $orderInformationUI
                ?? '<div style="font-family:sans-serif"><h3>' . Html::escape($input->description) . '</h3><p>' . Html::escape($currency) . ' '
                . Money::paisaToRupees2dp($input->amountPaisa) . '</p></div>',
        ]);
    }

    /**
     * With callback token: check oprSecret against oprKey, then merchant-status, then the transaction must carry your
     * orderId. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot prove the
     * transaction is yours, so a success there comes back "unknown" for manual review.
     */
    public function verify(VerifyInput $input): VerifyResult
    {
        $orderId = $input->orderId;
        $token = $input->callback['token'] ?? null;
        if ($token === null || $token === '') {
            $s = $this->call('transaction-statement', ['clientRequestId' => $orderId]);
            if ($s === null) {
                return new VerifyResult(ProviderId::GetPay, PaymentStatus::NotFound, $orderId, null, null, null);
            }
            $st = self::mapStatus($s['status'] ?? null);
            $tx = $s['transactionId'] ?? null;

            return new VerifyResult(
                ProviderId::GetPay,
                $st === PaymentStatus::Paid ? PaymentStatus::Unknown : $st,
                $orderId,
                self::paisa($s['saleTransactionAmount'] ?? null),
                is_string($tx) ? $tx : null,
                $s,
            );
        }
        $t = self::decodeToken($token);
        if ($t === null) {
            throw new PaymentException('GetPay: return token is not base64 {id, oprSecret}', ProviderId::GetPay, 'malformed_callback', 400);
        }
        if (!Crypto::safeEqual(self::oprSecret($this->cfg->oprKey, $t['id']), $t['oprSecret'])) {
            throw new PaymentException('GetPay: oprSecret does not match oprKey + id', ProviderId::GetPay, 'bad_signature', 400, ['id' => $t['id']]);
        }
        $d = $this->status($t['id']);
        if ($d === null) {
            return new VerifyResult(ProviderId::GetPay, PaymentStatus::NotFound, $orderId, null, $t['id'], null);
        }
        if (Js::toString($d['clientId'] ?? '') !== $orderId) {
            throw new PaymentException('GetPay: transaction belongs to a different clientRequestId', ProviderId::GetPay, 'id_mismatch', 400, $d);
        }

        return new VerifyResult(ProviderId::GetPay, self::mapStatus($d['status'] ?? null), $orderId, self::paisa($d['amount'] ?? null), $t['id'], $d);
    }

    /**
     * merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks}; null if unknown.
     *
     * @return array<array-key, mixed>|null
     */
    public function status(string $transactionId): ?array
    {
        return $this->call('merchant-status', ['id' => $transactionId, 'papInfo' => $this->cfg->papInfo]);
    }

    /**
     * transaction-statement: payer, masked PAN, scheme, stan, crrn.
     *
     * @param array{transactionId: string}|array{clientRequestId: string} $query
     * @return array<array-key, mixed>|null
     */
    public function statement(array $query): ?array
    {
        return $this->call('transaction-statement', $query);
    }

    /** The orderId is in YOUR return URL path (GetPay adds only the token); extract it from the route instead. */
    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);

        return Js::firstTruthy($p['clientRequestId'] ?? null, $p['orderId'] ?? null);
    }

    /** Page 1: loads the bundle and starts checkout; onSuccess opens `$paymentPageUrl`. */
    public function checkoutPage(SdkResult $r, string $paymentPageUrl): string
    {
        return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title>' . "\n"
            . '<script defer src="' . Html::escape($r->scriptUrl) . '"></script></head><body><div id="checkout" hidden></div><noscript>JavaScript is required to pay by card.</noscript>' . "\n"
            . '<script>window.addEventListener("load",function(){var o=' . self::scriptJson($r->options) . ';o.onSuccess=function(){location.href=' . self::scriptJson($paymentPageUrl)
            . '};o.onError=function(e){document.body.insertAdjacentHTML("beforeend","<p>Card checkout could not start. Please try again.</p>");console.error(e)};new GetPay(o).initialize()});</script></body></html>';
    }

    /** Page 2: GetPay renders the card form into #checkout. */
    public function paymentPage(): string
    {
        return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay by card</title>' . "\n"
            . '<script defer src="' . Html::escape($this->bundleUrl) . '"></script></head><body><div id="checkout"></div></body></html>';
    }

    /**
     * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the query or the
     * #hash, and send it to `$verifyUrl` as ?token=. Your server then calls verify() with callback token.
     */
    public function returnPage(string $verifyUrl): string
    {
        return '<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title></head><body><p>Confirming your payment...</p>' . "\n"
            . '<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{var h=location.hash||"",q=new URLSearchParams(location.search);'
            . 'var t=q.get("token")||new URLSearchParams(h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");var u=new URL('
            . self::scriptJson($verifyUrl) . ',location.href);if(t)u.searchParams.set("token",t);location.replace(u.toString())}</script></body></html>';
    }

    /**
     * @param array<string, string> $body
     * @return array<array-key, mixed>|null
     */
    private function call(string $path, array $body): ?array
    {
        $res = $this->http->request(ProviderId::GetPay, "{$this->base}/{$path}", 'POST', [], $body, $this->cfg->timeoutMs, 2);
        $d = $res->data;
        if (is_array($d) && ($d['status'] ?? null) === -1 && preg_match('/not found/i', Js::toString($d['message'] ?? 'undefined')) === 1) {
            return null;
        }
        if ($res->status !== 200 || !is_array($d) || ($d['status'] ?? null) !== 0 || !is_array($d['data'] ?? null)) {
            $msg = is_array($d) && isset($d['message']) ? Js::toString($d['message']) : Js::slice($res->text, 200);
            throw new PaymentException("GetPay {$path} failed: {$msg}", ProviderId::GetPay, "http_{$res->status}", $res->status, $d);
        }

        return $d['data'];
    }

    private static function mapStatus(mixed $s): PaymentStatus
    {
        return self::TXN_STATUS[strtoupper(Js::toString($s ?? ''))] ?? PaymentStatus::Unknown;
    }

    private static function paisa(mixed $rupees): ?int
    {
        if ($rupees === null) {
            return null;
        }

        return Money::rupeesToPaisa(is_int($rupees) || is_float($rupees) || is_string($rupees) ? $rupees : Js::toString($rupees));
    }

    /** JSON for a <script> block: "<" becomes \u003c so a value cannot close the tag. */
    private static function scriptJson(mixed $v): string
    {
        return str_replace('<', '\u003c', Json::encode($v));
    }

    /**
     * JS `new URL(u).origin` for http(s) URLs: lowercase scheme and host, default port dropped. Other schemes give "null".
     *
     * @throws \InvalidArgumentException when $u is not an absolute URL
     */
    private static function origin(string $u): string
    {
        $p = parse_url(Js::trim($u));
        if ($p === false || !isset($p['scheme'])) {
            throw new \InvalidArgumentException("Invalid URL: {$u}");
        }
        $scheme = strtolower($p['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') {
            return 'null';
        }
        if (!isset($p['host']) || $p['host'] === '') {
            throw new \InvalidArgumentException("Invalid URL: {$u}");
        }
        $port = $p['port'] ?? null;
        $default = $scheme === 'https' ? 443 : 80;

        return "{$scheme}://" . strtolower($p['host']) . ($port !== null && $port !== $default ? ":{$port}" : '');
    }
}
