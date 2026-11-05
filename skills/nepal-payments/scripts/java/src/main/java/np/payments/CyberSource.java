package np.payments;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;

/**
 * CyberSource Secure Acceptance Hosted Checkout — the card gateway most Nepali banks provision (profile_id /
 * access_key / secret_key). Being sunset in favour of Unified Checkout (see references/cybersource.md); still works.
 *
 * <p>Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over signed_field_names order.
 */
public final class CyberSource implements PaymentAdapter {
    private static final DateTimeFormatter SIGNED_DATE_TIME = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);

    /**
     * @param transactionType "sale" (auth+capture, typical) or "authorization" (capture later)
     * @param currency        default "NPR"
     * @param locale          default "en-us"
     * @param useReturnUrlOverride send returnUrl/failureUrl as override_custom_receipt_page / override_custom_cancel_page
     */
    public record Config(Environment env, String profileId, String accessKey, String secretKey, String transactionType,
                         String currency, String locale, boolean useReturnUrlOverride) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(profileId, "profileId");
            Objects.requireNonNull(accessKey, "accessKey");
            Objects.requireNonNull(secretKey, "secretKey");
            if (transactionType == null) transactionType = "sale";
            if (currency == null) currency = "NPR";
            if (locale == null) locale = "en-us";
        }

        public static Config of(Environment env, String profileId, String accessKey, String secretKey) {
            return new Config(env, profileId, accessKey, secretKey, null, null, null, false);
        }

        public Config withTransactionType(String transactionType) {
            return new Config(env, profileId, accessKey, secretKey, transactionType, currency, locale, useReturnUrlOverride);
        }

        public Config withCurrency(String currency) {
            return new Config(env, profileId, accessKey, secretKey, transactionType, currency, locale, useReturnUrlOverride);
        }

        public Config withLocale(String locale) {
            return new Config(env, profileId, accessKey, secretKey, transactionType, currency, locale, useReturnUrlOverride);
        }

        public Config withReturnUrlOverride(boolean useReturnUrlOverride) {
            return new Config(env, profileId, accessKey, secretKey, transactionType, currency, locale, useReturnUrlOverride);
        }
    }

    /** Required for sale/authorization. country = ISO 3166 alpha-2 ("NP"); phone/postalCode/state nullable (postal/state only for US/CA). */
    public record BillTo(String forename, String surname, String email, String addressLine1, String city, String country,
                         String phone, String postalCode, String state) {
        public static BillTo of(String forename, String surname, String email, String addressLine1, String city, String country) {
            return new BillTo(forename, surname, email, addressLine1, city, country, null, null, null);
        }
    }

    private final Config cfg;
    private final String host;

    public CyberSource(Config cfg) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.host = cfg.env() == Environment.SANDBOX ? "https://testsecureacceptance.cybersource.com" : "https://secureacceptance.cybersource.com";
    }

    @Override
    public ProviderId id() {
        return ProviderId.CYBERSOURCE;
    }

    /** Signature over fields.signed_field_names, in that order; missing fields sign as "". */
    public static String sign(String secretKey, Map<String, String> fields) {
        List<String> parts = new ArrayList<>();
        for (String n : Js.split(fields.get("signed_field_names"), ',')) {
            String v = fields.get(n);
            parts.add(n + "=" + (v == null ? "" : v));
        }
        return Codec.toBase64(Crypto.hmac(Crypto.Hash.SHA_256, secretKey, String.join(",", parts)));
    }

    /** UTC yyyy-MM-dd'T'HH:mm:ss'Z' — keep the server clock NTP-synced. */
    public static String signedDateTime(Instant at) {
        return SIGNED_DATE_TIME.format(at.truncatedTo(ChronoUnit.SECONDS).atOffset(ZoneOffset.UTC));
    }

    public static String signedDateTime() {
        return signedDateTime(Instant.now());
    }

    /** ACCEPT -> paid (pending for authorization-only); REVIEW -> pending; DECLINE/ERROR -> failed (150-152 -> unknown); CANCEL -> canceled. */
    private static PaymentStatus mapDecision(String decision, String reasonCode, String txnType) {
        String d = decision == null ? "" : decision.toUpperCase(Locale.ROOT);
        switch (d) {
            case "ACCEPT":
                return txnType.startsWith("authorization") ? PaymentStatus.PENDING : PaymentStatus.PAID; // auth-only isn't captured money yet
            case "REVIEW":
                return PaymentStatus.PENDING;
            case "DECLINE", "ERROR":
                return reasonCode != null && List.of("150", "151", "152").contains(reasonCode) ? PaymentStatus.UNKNOWN : PaymentStatus.FAILED; // system errors: re-check
            case "CANCEL":
                return PaymentStatus.CANCELED;
            default:
                return PaymentStatus.UNKNOWN;
        }
    }

    /** Verify a Secure Acceptance response POST (receipt page or Merchant POST URL). */
    public boolean responseValid(Map<String, String> params) {
        if (!Js.truthy(params.get("signed_field_names")) || !Js.truthy(params.get("signature"))) return false;
        return Crypto.safeEqual(sign(cfg.secretKey(), params), params.get("signature"));
    }

    /** Only trust fields listed in the response's signed_field_names. */
    private static Map<String, String> signedOnly(Map<String, String> params) {
        Map<String, String> out = new LinkedHashMap<>();
        String names = params.get("signed_field_names");
        for (String n : Js.split(names == null ? "" : names, ',')) {
            if (params.containsKey(n)) out.put(n, params.get(n));
        }
        return out;
    }

    /** CyberSource needs bill-to details: use {@link #initiate(InitiateInput, BillTo)}. */
    @Override
    public InitiateResult initiate(InitiateInput input) {
        throw new IllegalArgumentException("CyberSource: billTo is required; call initiate(input, billTo)");
    }

    public InitiateResult initiate(InitiateInput input, BillTo billTo) {
        return initiate(input, billTo, null);
    }

    /**
     * Form POST to /pay. orderId -> transaction_uuid AND reference_number (both <= 50 chars). Every field is signed;
     * unsigned_field_names is sent empty.
     *
     * @param merchantDefinedData index -> value (no PII allowed); nullable
     */
    public InitiateResult initiate(InitiateInput input, BillTo b, Map<Integer, String> merchantDefinedData) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.CYBERSOURCE);
        if (input.orderId().length() > 50) throw new PaymentException("CyberSource ids must be <= 50 chars", ProviderId.CYBERSOURCE, "invalid_order_id");
        Objects.requireNonNull(b, "billTo");
        Map<String, String> f = new LinkedHashMap<>();
        f.put("access_key", cfg.accessKey());
        f.put("profile_id", cfg.profileId());
        f.put("transaction_uuid", input.orderId());
        f.put("signed_date_time", signedDateTime());
        f.put("locale", cfg.locale());
        f.put("transaction_type", cfg.transactionType());
        f.put("reference_number", input.orderId());
        f.put("amount", input.amountPaisa() / 100 + "." + String.format(Locale.ROOT, "%02d", input.amountPaisa() % 100)); // "1500.00"
        f.put("currency", cfg.currency());
        f.put("bill_to_forename", b.forename());
        f.put("bill_to_surname", b.surname());
        f.put("bill_to_email", b.email());
        f.put("bill_to_address_line1", b.addressLine1());
        f.put("bill_to_address_city", b.city());
        f.put("bill_to_address_country", b.country());
        if (Js.truthy(b.phone())) f.put("bill_to_phone", b.phone());
        if (Js.truthy(b.postalCode())) f.put("bill_to_address_postal_code", b.postalCode());
        if (Js.truthy(b.state())) f.put("bill_to_address_state", b.state());
        if (cfg.useReturnUrlOverride()) f.put("override_custom_receipt_page", input.returnUrl());
        if (cfg.useReturnUrlOverride() && Js.truthy(input.failureUrl())) f.put("override_custom_cancel_page", input.failureUrl());
        if (merchantDefinedData != null) {
            new TreeMap<>(merchantDefinedData).forEach((i, v) -> f.put("merchant_defined_data" + i, v)); // JS orders integer keys ascending
        }
        f.put("unsigned_field_names", "");
        List<String> names = new ArrayList<>(f.keySet());
        names.remove("unsigned_field_names");
        names.add("unsigned_field_names");
        names.add("signed_field_names");
        f.put("signed_field_names", String.join(",", names));
        f.put("signature", sign(cfg.secretKey(), f));
        return new InitiateResult.Form(host + "/pay", f);
    }

    /**
     * Secure Acceptance has no simple status API: the signed response POST IS the proof. Pass the POST body as
     * {@code callback} (receipt page or, better, the Merchant POST URL). Only signed fields are used; an empty
     * auth_amount falls back to req_amount. For reconciliation without a callback use REST Transaction Search.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        Map<String, String> callback = input.callback();
        if (callback == null) {
            throw new PaymentException("CyberSource SA: verification needs the signed response POST; use REST transaction search for reconciliation",
                    ProviderId.CYBERSOURCE, "verify_unavailable");
        }
        if (!responseValid(callback)) {
            throw new PaymentException("CyberSource: invalid response signature — treat as malicious", ProviderId.CYBERSOURCE, "invalid_signature", 400, null);
        }
        Map<String, String> p = signedOnly(callback);
        String ref = Js.truthy(p.get("req_reference_number")) ? p.get("req_reference_number") : p.get("req_transaction_uuid");
        if (!input.orderId().equals(ref)) {
            throw new PaymentException("CyberSource: response is for a different order", ProviderId.CYBERSOURCE, "callback_mismatch", 400, p);
        }
        if (Js.truthy(p.get("req_currency")) && !p.get("req_currency").equals(cfg.currency())) {
            throw new PaymentException("CyberSource: currency mismatch", ProviderId.CYBERSOURCE, "currency_mismatch", 400, p);
        }
        String paid = Js.truthy(p.get("auth_amount")) ? p.get("auth_amount") : p.get("req_amount");
        String txnType = p.get("req_transaction_type") != null ? p.get("req_transaction_type") : cfg.transactionType();
        // reason 110 = partial approval: auth_amount < requested. The amount guard in decideTransition catches it.
        return new VerifyResult(ProviderId.CYBERSOURCE, mapDecision(p.get("decision"), p.get("reason_code"), txnType), input.orderId(),
                Js.truthy(paid) ? Money.rupeesToPaisa(paid) : null, p.get("transaction_id"), p);
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("req_reference_number");
        if (Js.truthy(id)) return Optional.of(id);
        id = params.get("req_transaction_uuid");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }
}
