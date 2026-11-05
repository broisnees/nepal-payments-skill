package np.payments;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * eSewa — https://developer.esewa.com.np
 *
 * <p>Two flows: ePay v2 (web / WebView: signed form POST -> success_url?data=base64 JSON -> status API) and Intent
 * (mobile app-to-app: book -> deeplink -> callback_url POST -> status API).
 *
 * <p>Signature (both): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in signed_field_names order. The example
 * signatures printed in eSewa's docs are wrong; see the test vectors.
 */
public final class Esewa implements PaymentAdapter {
    public static final String SANDBOX_PRODUCT_CODE = "EPAYTEST";
    public static final String SANDBOX_SECRET_KEY = "8gBm/:&EnhH.1/q";
    public static final String SANDBOX_INTENT_PRODUCT_CODE = "INTENT";
    /** Use as the raw string, NOT base64-decoded. */
    public static final String SANDBOX_INTENT_ACCESS_KEY = "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==";

    private static final String SANDBOX_FORM = "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
    private static final String SANDBOX_STATUS = "https://rc.esewa.com.np/api/epay/transaction/status/";
    private static final String SANDBOX_INTENT = "https://rc-checkout.esewa.com.np/api/client/intent/payment";
    private static final String PRODUCTION_FORM = "https://epay.esewa.com.np/api/epay/main/v2/form";
    private static final String PRODUCTION_STATUS = "https://esewa.com.np/api/epay/transaction/status/";

    private static final Pattern UUID_CHARSET = Pattern.compile("[A-Za-z0-9-]+");
    private static final List<String> REQUEST_SIGNED = List.of("total_amount", "transaction_uuid", "product_code");

    private static final Map<String, PaymentStatus> EPAY_STATUS = Map.of(
            "COMPLETE", PaymentStatus.PAID,
            "PENDING", PaymentStatus.PENDING,
            "AMBIGUOUS", PaymentStatus.PENDING, // "payment is at halt state": keep re-checking
            "FULL_REFUND", PaymentStatus.REFUNDED,
            "PARTIAL_REFUND", PaymentStatus.PARTIALLY_REFUNDED,
            "NOT_FOUND", PaymentStatus.NOT_FOUND, // session expired / never paid / wrong amount
            "CANCELED", PaymentStatus.CANCELED);

    private static final Map<String, PaymentStatus> INTENT_STATUS = Map.of(
            "SUCCESS", PaymentStatus.PAID,
            "BOOKED", PaymentStatus.PENDING,
            "PENDING", PaymentStatus.PENDING,
            "FAILED", PaymentStatus.FAILED,
            "CANCELED", PaymentStatus.CANCELED,
            "REVERTED", PaymentStatus.REFUNDED);

    /**
     * @param secretKey       ePay secret key; "&amp;amp;" (HTML-escaped by some config UIs) is turned back into "&amp;"
     * @param intent          Intent (mobile) credentials; null if you don't use Intent
     * @param formUrl         override; null = default for env
     * @param statusUrl       override; null = default for env
     * @param strictSignature throw when the success-redirect signature doesn't verify (status API is checked regardless)
     */
    public record Config(Environment env, String productCode, String secretKey, Intent intent, String formUrl,
                         String statusUrl, boolean strictSignature, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(productCode, "productCode");
            Objects.requireNonNull(secretKey, "secretKey");
            if (timeout == null) timeout = Http.DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String productCode, String secretKey) {
            return new Config(env, productCode, secretKey, null, null, null, true, null);
        }

        /** Public sandbox credentials, including Intent (TS: {@code { env: "sandbox", ...ESEWA_SANDBOX }}). */
        public static Config sandbox() {
            return of(Environment.SANDBOX, SANDBOX_PRODUCT_CODE, SANDBOX_SECRET_KEY)
                    .withIntent(new Intent(SANDBOX_INTENT_PRODUCT_CODE, SANDBOX_INTENT_ACCESS_KEY, null));
        }

        public Config withIntent(Intent intent) {
            return new Config(env, productCode, secretKey, intent, formUrl, statusUrl, strictSignature, timeout);
        }

        public Config withUrls(String formUrl, String statusUrl) {
            return new Config(env, productCode, secretKey, intent, formUrl, statusUrl, strictSignature, timeout);
        }

        public Config withStrictSignature(boolean strictSignature) {
            return new Config(env, productCode, secretKey, intent, formUrl, statusUrl, strictSignature, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, productCode, secretKey, intent, formUrl, statusUrl, strictSignature, timeout);
        }
    }

    /** Intent credentials. {@code baseUrl} null = sandbox default; production host is issued by eSewa at go-live. */
    public record Intent(String productCode, String accessKey, String baseUrl) {}

    /**
     * Optional breakdown, INCLUDED in amountPaisa. amountPaisa is always the TOTAL charged (the number you store and
     * later pass to verify()); eSewa's {@code amount} field = amountPaisa - tax - service - delivery.
     */
    public record Extras(long taxPaisa, long serviceChargePaisa, long deliveryChargePaisa) {
        public static final Extras NONE = new Extras(0, 0, 0);
    }

    /** Decoded success payload and whether its signature verified. */
    public record ParsedSuccess(Map<String, Object> payload, boolean signatureValid) {}

    /** {@code providerRef} = "bookingId|correlationId": persist it on the attempt. */
    public record IntentBooking(String bookingId, String deeplink, String correlationId, String providerRef, Object raw) {}

    private final Config cfg;
    private final Http http;
    private final String formUrl;
    private final String statusUrl;
    private final String secret;

    public Esewa(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public Esewa(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        boolean sandbox = cfg.env() == Environment.SANDBOX;
        this.formUrl = cfg.formUrl() != null ? cfg.formUrl() : sandbox ? SANDBOX_FORM : PRODUCTION_FORM;
        this.statusUrl = cfg.statusUrl() != null ? cfg.statusUrl() : sandbox ? SANDBOX_STATUS : PRODUCTION_STATUS;
        this.secret = cfg.secretKey().replace("&amp;", "&");
    }

    @Override
    public ProviderId id() {
        return ProviderId.ESEWA;
    }

    /** base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order; missing fields sign as "". */
    public static String sign(String key, Map<String, ?> fields, List<String> order) {
        StringBuilder message = new StringBuilder();
        for (int i = 0; i < order.size(); i++) {
            if (i > 0) message.append(',');
            message.append(order.get(i)).append('=').append(Js.stringOrEmpty(fields.get(order.get(i))));
        }
        return Codec.toBase64(Crypto.hmac(Crypto.Hash.SHA_256, key, message.toString()));
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, Extras.NONE);
    }

    /**
     * Form to auto-submit (application/x-www-form-urlencoded POST). Keep returnUrl/failureUrl free of query strings
     * (eSewa appends ?data=...); put your attempt id in the PATH so failures can be matched too.
     */
    public InitiateResult initiate(InitiateInput input, Extras extras) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.ESEWA);
        if (!UUID_CHARSET.matcher(input.orderId()).matches()) {
            throw new PaymentException("eSewa transaction_uuid allows only letters, digits and '-'", ProviderId.ESEWA, "invalid_order_id");
        }
        long tax = extras.taxPaisa();
        long svc = extras.serviceChargePaisa();
        long del = extras.deliveryChargePaisa();
        long base = input.amountPaisa() - tax - svc - del; // amountPaisa is the TOTAL charged
        if (!validCharge(tax) || !validCharge(svc) || !validCharge(del) || base <= 0) {
            throw new PaymentException("eSewa: tax/charges must be non-negative paisa and less than the total", ProviderId.ESEWA, "invalid_amount");
        }
        // Format ONCE and use the same strings in the form and in the signature ("110" vs "110.0" -> ES104).
        Map<String, String> f = new LinkedHashMap<>();
        f.put("amount", Money.paisaToRupees(base));
        f.put("tax_amount", Money.paisaToRupees(tax));
        f.put("product_service_charge", Money.paisaToRupees(svc));
        f.put("product_delivery_charge", Money.paisaToRupees(del));
        f.put("total_amount", Money.paisaToRupees(input.amountPaisa()));
        f.put("transaction_uuid", input.orderId());
        f.put("product_code", cfg.productCode());
        f.put("success_url", input.returnUrl());
        f.put("failure_url", input.failureUrlOrReturnUrl());
        f.put("signed_field_names", "total_amount,transaction_uuid,product_code");
        f.put("signature", sign(secret, f, REQUEST_SIGNED));
        return new InitiateResult.Form(formUrl, f);
    }

    private static boolean validCharge(long n) {
        return n >= 0 && n <= Money.MAX_SAFE_INTEGER;
    }

    /**
     * Decode + verify the base64 {@code data} param from success_url. Numeric fields are signed as their raw JSON text
     * ("1000.0" stays "1000.0"); a comma-formatted total_amount is retried without commas. Does NOT prove payment.
     *
     * @throws PaymentException malformed_callback if data isn't base64 JSON with signed_field_names
     */
    public ParsedSuccess parseSuccess(String data) {
        String text;
        Object parsed;
        try {
            text = Codec.decodeUtf8Strict(Codec.fromBase64(data));
            parsed = Json.parse(text);
        } catch (IllegalArgumentException e) { // bad base64, invalid UTF-8 and JsonException alike
            throw new PaymentException("eSewa: success data is not base64 JSON", ProviderId.ESEWA, "malformed_callback", 400, data);
        }
        if (!(parsed instanceof Map<?, ?> raw) || !(raw.get("signed_field_names") instanceof String names)) {
            throw new PaymentException("eSewa: malformed success payload", ProviderId.ESEWA, "malformed_callback", 400, parsed);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) raw;
        List<String> order = Js.split(names, ',').stream().map(Js::trim).toList();
        Map<String, String> fields = new LinkedHashMap<>();
        for (String f : order) fields.put(f, rawValue(text, payload, f));
        Object sig = payload.get("signature");
        boolean ok = sig instanceof String s && Crypto.safeEqual(sign(secret, fields, order), s);
        // eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed. Try both.
        String total = fields.get("total_amount");
        if (!ok && total != null && total.contains(",") && sig instanceof String s) {
            Map<String, String> alt = new LinkedHashMap<>(fields);
            alt.put("total_amount", total.replace(",", ""));
            ok = Crypto.safeEqual(sign(secret, alt, order), s);
        }
        return new ParsedSuccess(payload, ok);
    }

    /** Exact text of a field as eSewa sent it, so numbers keep their formatting. */
    private static String rawValue(String text, Map<String, Object> payload, String field) {
        Object v = payload.get(field);
        if (!(v instanceof BigDecimal)) return Js.stringOrEmpty(v);
        Matcher m = Pattern.compile("\"" + Pattern.quote(field) + "\"" + Js.WS + "*:" + Js.WS + "*(-?[0-9][0-9.eE+-]*)").matcher(text);
        return m.find() ? m.group(1) : Js.string(v);
    }

    /**
     * Authoritative check via the status API. If {@code callback.data} is present (success redirect) its signature and
     * uuid/product code are verified too. {@code amountPaisa} MUST be the TOTAL you charged: eSewa returns NOT_FOUND for
     * a wrong total, which doubles as an amount check.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        Boolean signatureValid = null;
        String data = input.callback() == null ? null : input.callback().get("data");
        if (Js.truthy(data)) {
            ParsedSuccess parsed = parseSuccess(data);
            signatureValid = parsed.signatureValid();
            if (!Objects.equals(parsed.payload().get("transaction_uuid"), input.orderId())
                    || !Objects.equals(parsed.payload().get("product_code"), cfg.productCode())) {
                throw new PaymentException("eSewa: callback does not match this attempt", ProviderId.ESEWA, "callback_mismatch", 400, parsed.payload());
            }
            if (!signatureValid && cfg.strictSignature()) {
                throw new PaymentException("eSewa: invalid response signature", ProviderId.ESEWA, "invalid_signature", 400, parsed.payload());
            }
        }
        Map<String, Object> s = statusCheck(input.orderId(), input.amountPaisa());
        Object total = s.get("total_amount");
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("status", s);
        raw.put("signatureValid", signatureValid);
        return new VerifyResult(
                ProviderId.ESEWA,
                status(EPAY_STATUS, s.get("status")),
                input.orderId(),
                total instanceof BigDecimal || total instanceof String ? Money.rupeesToPaisaOf(total) : null,
                Js.id(s.get("ref_id")),
                raw);
    }

    private Map<String, Object> statusCheck(String orderId, long amountPaisa) {
        Map<String, String> qs = new LinkedHashMap<>();
        qs.put("product_code", cfg.productCode());
        qs.put("total_amount", Money.paisaToRupees(amountPaisa));
        qs.put("transaction_uuid", orderId);
        Http.Response res = http.request(ProviderId.ESEWA, statusUrl + "?" + Codec.formEncode(qs),
                Http.Options.get().withTimeout(cfg.timeout()).withRetries(2));
        if (res.status() != 200 || !(res.data() instanceof Map<?, ?> m) || !m.containsKey("status")) {
            throw new PaymentException("eSewa status check failed: " + errorText(res), ProviderId.ESEWA, errorCode(res), res.status(), res.data());
        }
        return asMap(m);
    }

    /** From {@code data} (success redirect), else your path param on failure_url: orderId, order_id, transaction_uuid. */
    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String data = params.get("data");
        if (Js.truthy(data)) {
            try {
                String id = Js.stringOrEmpty(Js.get(Codec.base64Json(data), "transaction_uuid"));
                return id.isEmpty() ? Optional.empty() : Optional.of(id);
            } catch (IllegalArgumentException e) {
                return Optional.empty();
            }
        }
        for (String k : List.of("orderId", "order_id", "transaction_uuid")) {
            if (Js.truthy(params.get(k))) return Optional.of(params.get(k));
        }
        return Optional.empty();
    }

    // ------------------------------------------------------------------ Intent (mobile app-to-app)

    public IntentBooking intentBook(String orderId, long amountPaisa, String callbackUrl, String redirectUrl) {
        return intentBook(orderId, amountPaisa, callbackUrl, redirectUrl, null);
    }

    /**
     * Book an Intent payment. Open {@code deeplink} in the app (or mobile browser); the eSewa app handles payment.
     * Persist {@code providerRef}. Use whole-rupee amounts: decimal amount signing for Intent is not documented.
     *
     * @param callbackUrl server-to-server POST from eSewa
     * @param redirectUrl where the user lands after paying
     * @param properties  snake_case keys, shown to the user; null = {remarks: orderId}
     */
    public IntentBooking intentBook(String orderId, long amountPaisa, String callbackUrl, String redirectUrl, Map<String, String> properties) {
        Intent intent = requireIntent();
        Money.assertPaisa(amountPaisa, ProviderId.ESEWA);
        // TS: Number(paisaToRupees(x)) -> 100 / 100.5; the same text is signed.
        BigDecimal amount = new BigDecimal(Money.paisaToRupees(amountPaisa)).stripTrailingZeros();
        if (amount.scale() < 0) amount = amount.setScale(0);
        Map<String, String> signed = new LinkedHashMap<>();
        signed.put("product_code", intent.productCode());
        signed.put("amount", amount.toPlainString());
        signed.put("transaction_uuid", orderId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("product_code", intent.productCode());
        body.put("amount", amount);
        body.put("transaction_uuid", orderId);
        body.put("signed_field_names", "product_code,amount,transaction_uuid");
        body.put("signature", sign(intent.accessKey(), signed, List.of("product_code", "amount", "transaction_uuid")));
        body.put("callback_url", callbackUrl);
        body.put("redirect_url", redirectUrl);
        body.put("properties", properties != null ? new LinkedHashMap<>(properties) : Map.of("remarks", orderId));
        Http.Response res = http.request(ProviderId.ESEWA, intent.baseUrl() + "/book", Http.Options.post(body).withTimeout(cfg.timeout()));
        Object d = Js.get(res.data(), "data");
        if (!Js.truthy(Js.get(d, "booking_id"))) {
            throw new PaymentException("eSewa intent book failed: " + errorText(res), ProviderId.ESEWA, errorCode(res), res.status(), res.data());
        }
        String bookingId = Js.string(Js.get(d, "booking_id"));
        String correlationId = Js.stringOrEmpty(Js.get(d, "correlation_id"));
        return new IntentBooking(bookingId, Js.stringOrEmpty(Js.get(d, "deeplink")), correlationId, bookingId + "|" + correlationId, res.data());
    }

    public VerifyResult intentVerify(String orderId, String providerRef) {
        return intentVerify(orderId, providerRef, null);
    }

    /**
     * Authoritative Intent status. {@code providerRef} = "bookingId|correlationId" stored at booking. Pass the stored
     * amount: the status response has none, but the amount was signed at booking.
     */
    public VerifyResult intentVerify(String orderId, String providerRef, Long amountPaisa) {
        Intent intent = requireIntent();
        List<String> parts = Js.split(providerRef, '|');
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("booking_id", parts.get(0));
        fields.put("product_code", intent.productCode());
        if (parts.size() > 1) fields.put("correlation_id", parts.get(1)); // TS: undefined is dropped from the body
        List<String> order = List.of("booking_id", "product_code", "correlation_id");
        Map<String, Object> body = new LinkedHashMap<>(fields);
        body.put("signed_field_names", String.join(",", order));
        body.put("signature", sign(intent.accessKey(), fields, order));
        Http.Response res = http.request(ProviderId.ESEWA, intent.baseUrl() + "/status",
                Http.Options.post(body).withTimeout(cfg.timeout()).withRetries(2));
        Object d = Js.get(res.data(), "data");
        if (!Js.truthy(Js.get(d, "status"))) {
            throw new PaymentException("eSewa intent status failed: " + errorText(res), ProviderId.ESEWA, errorCode(res), res.status(), res.data());
        }
        Object txn = Js.get(d, "transaction_id");
        if (Js.truthy(txn) && !orderId.equals(txn)) {
            throw new PaymentException("eSewa intent: status is for a different transaction", ProviderId.ESEWA, "callback_mismatch", 400, d);
        }
        return new VerifyResult(ProviderId.ESEWA, status(INTENT_STATUS, Js.get(d, "status")), orderId, amountPaisa,
                Js.id(Js.get(d, "reference_code")), res.data());
    }

    /** Cancel a booking that hasn't completed (e.g. user abandoned). Returns the provider response. */
    public Object intentCancel(String providerRef) {
        Intent intent = requireIntent();
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("booking_id", Js.split(providerRef, '|').get(0));
        fields.put("product_code", intent.productCode());
        List<String> order = List.of("booking_id", "product_code");
        Map<String, Object> body = new LinkedHashMap<>(fields);
        body.put("signed_field_names", String.join(",", order));
        body.put("signature", sign(intent.accessKey(), fields, order));
        return http.request(ProviderId.ESEWA, intent.baseUrl() + "/cancel", Http.Options.post(body).withTimeout(cfg.timeout())).data();
    }

    /**
     * Verify the signature on eSewa's Intent callback POST body (parsed JSON). Values are signed as JS String(v), so a
     * JSON number 100.0 signs as "100". Prefer {@link #intentCallbackValid(String)} with the raw body. Still call
     * intentVerify() before fulfilling.
     */
    public boolean intentCallbackValid(Map<String, ?> body) {
        return intentCallbackValid(body, null);
    }

    /**
     * Same, from the RAW JSON request body; false if it isn't a JSON object. Numbers are then also checked exactly as
     * eSewa sent them ("100.0"), not only in the String(v) form ("100").
     */
    public boolean intentCallbackValid(String jsonBody) {
        Object parsed;
        try {
            parsed = Json.parse(jsonBody);
        } catch (JsonException e) {
            requireIntent();
            return false;
        }
        if (!(parsed instanceof Map<?, ?> m)) {
            requireIntent();
            return false;
        }
        return intentCallbackValid(asMap(m), jsonBody);
    }

    private boolean intentCallbackValid(Map<String, ?> body, String text) {
        Intent intent = requireIntent();
        if (!(body.get("signed_field_names") instanceof String names) || !(body.get("signature") instanceof String sig)) return false;
        List<String> order = Js.split(names, ',').stream().map(Js::trim).toList();
        Map<String, String> asString = new LinkedHashMap<>();
        for (String f : order) asString.put(f, Js.stringOrEmpty(body.get(f)));
        if (Crypto.safeEqual(sign(intent.accessKey(), asString, order), sig)) return true;
        if (text == null) return false;
        Map<String, String> exact = new LinkedHashMap<>();
        for (String f : order) exact.put(f, rawValue(text, asMap(body), f));
        return !exact.equals(asString) && Crypto.safeEqual(sign(intent.accessKey(), exact, order), sig);
    }

    private Intent requireIntent() {
        if (cfg.intent() == null) throw new IllegalStateException("eSewa: configure `intent` credentials to use Intent payments");
        String baseUrl = cfg.intent().baseUrl() != null ? cfg.intent().baseUrl() : cfg.env() == Environment.SANDBOX ? SANDBOX_INTENT : null;
        if (baseUrl == null || baseUrl.isEmpty()) {
            throw new IllegalStateException("eSewa: production Intent baseUrl is issued by eSewa at go-live; set intent.baseUrl");
        }
        return new Intent(cfg.intent().productCode(), cfg.intent().accessKey(), baseUrl);
    }

    private static PaymentStatus status(Map<String, PaymentStatus> table, Object providerStatus) {
        PaymentStatus s = providerStatus instanceof String str ? table.get(str) : null;
        return s != null ? s : PaymentStatus.UNKNOWN;
    }

    /** Docs say {@code error_message}; the live Intent sandbox sends {@code errorMessage}. */
    private static String errorText(Http.Response res) {
        Object em = Js.get(res.data(), "error_message");
        if (em == null) em = Js.get(res.data(), "errorMessage");
        return em != null ? Js.string(em) : Js.slice(res.text(), 200);
    }

    /** {@code esewa_<code>} when the body carries a code, else {@code http_<status>}. */
    private static String errorCode(Http.Response res) {
        Object code = Js.get(res.data(), "code");
        return code != null ? "esewa_" + Js.string(code) : "http_" + res.status();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }
}
