<?php

declare(strict_types=1);

namespace NepalPayments\CyberSource;

use NepalPayments\Crypto;
use NepalPayments\FormResult;
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
 * CyberSource Secure Acceptance Hosted Checkout (bank-issued profile_id / access_key / secret_key).
 * Being sunset in favour of Unified Checkout (see references/cybersource.md); still works.
 *
 * Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over `signed_field_names` order.
 */
final class CyberSourceAdapter implements PaymentAdapter
{
    private const HOST = ['sandbox' => 'https://testsecureacceptance.cybersource.com', 'production' => 'https://secureacceptance.cybersource.com'];

    private readonly string $host;

    public function __construct(private readonly CyberSourceConfig $cfg)
    {
        $this->host = self::HOST[$cfg->env->value];
    }

    public function id(): ProviderId
    {
        return ProviderId::CyberSource;
    }

    /** @param array<string, string> $fields Must contain signed_field_names. */
    public static function sign(string $secretKey, array $fields): string
    {
        $parts = [];
        foreach (explode(',', $fields['signed_field_names'] ?? '') as $n) {
            $parts[] = $n . '=' . ($fields[$n] ?? '');
        }

        return Crypto::toBase64(Crypto::hmac('sha256', $secretKey, implode(',', $parts)));
    }

    /** UTC "yyyy-MM-dd'T'HH:mm:ss'Z'" — keep the server clock NTP-synced. */
    public static function signedDateTime(?\DateTimeInterface $at = null): string
    {
        $d = \DateTimeImmutable::createFromInterface($at ?? new \DateTimeImmutable('now'));

        return $d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    /**
     * Form POST to /pay. orderId -> transaction_uuid AND reference_number (both <= 50 chars).
     * billTo is required for sale/authorization (country "NP"; state/postal code only for US/CA).
     *
     * @param array<int, string> $merchantDefinedData index => value (no PII allowed)
     */
    public function initiate(InitiateInput $input, ?BillTo $billTo = null, array $merchantDefinedData = []): FormResult
    {
        Money::assertPaisa($input->amountPaisa, ProviderId::CyberSource);
        if (Js::length($input->orderId) > 50) {
            throw new PaymentException('CyberSource ids must be <= 50 chars', ProviderId::CyberSource, 'invalid_order_id');
        }
        if ($billTo === null) {
            throw new \InvalidArgumentException('CyberSource: billTo is required');
        }
        $b = $billTo;
        $fields = [
            'access_key' => $this->cfg->accessKey,
            'profile_id' => $this->cfg->profileId,
            'transaction_uuid' => $input->orderId,
            'signed_date_time' => self::signedDateTime(),
            'locale' => $this->cfg->locale,
            'transaction_type' => $this->cfg->transactionType,
            'reference_number' => $input->orderId,
            'amount' => Money::paisaToRupees2dp($input->amountPaisa), // "1500.00"
            'currency' => $this->cfg->currency,
            'bill_to_forename' => $b->forename,
            'bill_to_surname' => $b->surname,
            'bill_to_email' => $b->email,
            'bill_to_address_line1' => $b->addressLine1,
            'bill_to_address_city' => $b->city,
            'bill_to_address_country' => $b->country,
        ];
        if (($b->phone ?? '') !== '') {
            $fields['bill_to_phone'] = (string) $b->phone;
        }
        if (($b->postalCode ?? '') !== '') {
            $fields['bill_to_address_postal_code'] = (string) $b->postalCode;
        }
        if (($b->state ?? '') !== '') {
            $fields['bill_to_address_state'] = (string) $b->state;
        }
        if ($this->cfg->useReturnUrlOverride) {
            $fields['override_custom_receipt_page'] = $input->returnUrl;
            if (($input->failureUrl ?? '') !== '') {
                $fields['override_custom_cancel_page'] = (string) $input->failureUrl;
            }
        }
        ksort($merchantDefinedData, SORT_NUMERIC); // JS iterates integer keys in ascending order
        foreach ($merchantDefinedData as $i => $v) {
            $fields["merchant_defined_data{$i}"] = $v;
        }
        $names = array_keys($fields);
        $fields['unsigned_field_names'] = '';
        $fields['signed_field_names'] = implode(',', [...$names, 'unsigned_field_names', 'signed_field_names']);
        $fields['signature'] = self::sign($this->cfg->secretKey, $fields);

        return new FormResult("{$this->host}/pay", $fields);
    }

    /**
     * Verify a Secure Acceptance response POST (receipt page or Merchant POST URL).
     *
     * @param array<array-key, mixed> $params
     */
    public function responseValid(array $params): bool
    {
        $p = Js::stringMap($params);
        if (($p['signed_field_names'] ?? '') === '' || ($p['signature'] ?? '') === '') {
            return false;
        }

        return Crypto::safeEqual(self::sign($this->cfg->secretKey, $p), $p['signature']);
    }

    /**
     * Secure Acceptance has no simple status API: the signed response POST IS the proof. Pass the POST body as
     * `callback`. Only fields listed in signed_field_names are used. For reconciliation without a callback, use
     * the REST Transaction Search via the official SDK (references/cybersource.md).
     */
    public function verify(VerifyInput $input): VerifyResult
    {
        $callback = $input->callback;
        if ($callback === null) {
            throw new PaymentException(
                'CyberSource SA: verification needs the signed response POST; use REST transaction search for reconciliation',
                ProviderId::CyberSource,
                'verify_unavailable',
            );
        }
        if (!$this->responseValid($callback)) {
            throw new PaymentException('CyberSource: invalid response signature — treat as malicious', ProviderId::CyberSource, 'invalid_signature', 400);
        }
        $p = [];
        foreach (explode(',', $callback['signed_field_names'] ?? '') as $n) {
            if (array_key_exists($n, $callback)) {
                $p[$n] = $callback[$n];
            }
        }
        if (($p['req_reference_number'] ?? $p['req_transaction_uuid'] ?? null) !== $input->orderId) {
            throw new PaymentException('CyberSource: response is for a different order', ProviderId::CyberSource, 'callback_mismatch', 400, $p);
        }
        if (($p['req_currency'] ?? '') !== '' && $p['req_currency'] !== $this->cfg->currency) {
            throw new PaymentException('CyberSource: currency mismatch', ProviderId::CyberSource, 'currency_mismatch', 400, $p);
        }
        // signed-but-empty auth_amount falls back to req_amount
        $paid = Js::firstTruthy($p['auth_amount'] ?? null, $p['req_amount'] ?? null);
        $status = self::mapDecision($p['decision'] ?? null, $p['reason_code'] ?? null, $p['req_transaction_type'] ?? $this->cfg->transactionType);

        // reason 110 = partial approval: auth_amount < requested. The amount guard (decideTransition) catches it.
        return new VerifyResult(
            ProviderId::CyberSource,
            $status,
            $input->orderId,
            $paid !== null ? Money::rupeesToPaisa($paid) : null,
            $p['transaction_id'] ?? null,
            $p,
        );
    }

    public function orderIdFromCallback(array $params): ?string
    {
        $p = Js::stringMap($params);

        return Js::firstTruthy($p['req_reference_number'] ?? null, $p['req_transaction_uuid'] ?? null);
    }

    /**
     * ACCEPT -> paid (for "sale"); REVIEW -> pending; DECLINE / ERROR -> failed (150/151/152 system errors -> unknown);
     * CANCEL -> canceled.
     */
    private static function mapDecision(?string $decision, ?string $reasonCode, string $txnType): PaymentStatus
    {
        return match ($decision === null ? null : strtoupper($decision)) {
            'ACCEPT' => str_starts_with($txnType, 'authorization') ? PaymentStatus::Pending : PaymentStatus::Paid, // auth-only isn't captured money yet
            'REVIEW' => PaymentStatus::Pending,
            'DECLINE', 'ERROR' => in_array($reasonCode, ['150', '151', '152'], true) ? PaymentStatus::Unknown : PaymentStatus::Failed,
            'CANCEL' => PaymentStatus::Canceled,
            default => PaymentStatus::Unknown,
        };
    }
}
