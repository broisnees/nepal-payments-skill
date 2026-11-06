package np.payments;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Hamro Pay Checkout (Hamro Patro's wallet). https://hamropay.com.np/checkout/developer/reference/
 * Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
 * merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook signing secret.
 *
 * <p>Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
 * {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
 *
 * <p>Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
 * <pre>
 *   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
 *   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
 *   get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
 *   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
 * </pre>
 * transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
 */
public final class HamroPay implements PaymentAdapter {
    public static final long MIN_PAISA = 1000;
    public static final long MAX_PAISA = 5_000_000;

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(15);
    private static final String SANDBOX_API = "https://uat-payclient.hamropatro.com";
    private static final String PRODUCTION_API = "https://payclient.hamropatro.com";
    private static final String SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout";
    private static final Pattern TXN_ID = Pattern.compile("[A-Za-z0-9-]{1,25}");

    private static final Map<String, PaymentStatus> TXN_STATUS = Map.of(
            "COMPLETED", PaymentStatus.PAID,
            "FAILED", PaymentStatus.FAILED,
            "PENDING", PaymentStatus.PENDING,
            "PROCESSING", PaymentStatus.PENDING,
            "NOT_INITIATED", PaymentStatus.NOT_FOUND,
            "CANCELED", PaymentStatus.CANCELED,
            "CANCELLED", PaymentStatus.CANCELED);

    /**
     * @param webhookSecret signing secret shown when you save the webhook URL in the merchant portal; needed for
     *                      {@link #verifyWebhook}. null = none
     * @param apiBaseUrl    API host override; null = UAT https://uat-payclient.hamropatro.com, live https://payclient.hamropatro.com
     * @param gatewayUrl    full gateway form URL ({gateway}/api/checkout); required in production (Hamro Pay issues the live host)
     */
    public record Config(Environment env, String merchantId, String clientId, String clientApiKey, String clientSecret,
                         String webhookSecret, String apiBaseUrl, String gatewayUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(merchantId, "merchantId");
            Objects.requireNonNull(clientId, "clientId");
            Objects.requireNonNull(clientApiKey, "clientApiKey");
            Objects.requireNonNull(clientSecret, "clientSecret");
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String merchantId, String clientId, String clientApiKey, String clientSecret) {
            return new Config(env, merchantId, clientId, clientApiKey, clientSecret, null, null, null, null);
        }

        public Config withWebhookSecret(String webhookSecret) {
            return new Config(env, merchantId, clientId, clientApiKey, clientSecret, webhookSecret, apiBaseUrl, gatewayUrl, timeout);
        }

        public Config withApiBaseUrl(String apiBaseUrl) {
            return new Config(env, merchantId, clientId, clientApiKey, clientSecret, webhookSecret, apiBaseUrl, gatewayUrl, timeout);
        }

        public Config withGatewayUrl(String gatewayUrl) {
            return new Config(env, merchantId, clientId, clientApiKey, clientSecret, webhookSecret, apiBaseUrl, gatewayUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, merchantId, clientId, clientApiKey, clientSecret, webhookSecret, apiBaseUrl, gatewayUrl, timeout);
        }
    }

    private final Config cfg;
    private final Http http;
    private final String api;
    private final String gateway;

    public HamroPay(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public HamroPay(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        String a = cfg.apiBaseUrl() != null ? cfg.apiBaseUrl() : cfg.env() == Environment.SANDBOX ? SANDBOX_API : PRODUCTION_API;
        this.api = a.endsWith("/") ? a.substring(0, a.length() - 1) : a;
        this.gateway = cfg.gatewayUrl() != null ? cfg.gatewayUrl() : cfg.env() == Environment.SANDBOX ? SANDBOX_GATEWAY : null;
    }

    @Override
    public ProviderId id() {
        return ProviderId.HAMROPAY;
    }

    /**
     * base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a value would let two
     * different tuples share a signature: refuse it instead.
     */
    public static String sign(String secret, String... values) {
        for (String v : values) {
            if (v.contains(",")) throw new IllegalArgumentException("hamropay: signed values must not contain commas");
        }
        return Codec.toBase64(Crypto.hmac(Crypto.Hash.SHA_512, secret, String.join(",", values)));
    }

    private Map<String, Object> post(String path, Object body, int retries, String... signed) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Signature", sign(cfg.clientSecret(), signed));
        headers.put("Client-Id", cfg.clientId());
        headers.put("Client-API-Key", cfg.clientApiKey());
        // The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on the
        // next call (Hamro Pay's own sample measured every second request failing on UAT). JdkHttpTransport cannot send
        // this header, so it runs these exchanges on a client of their own instead.
        headers.put("Connection", "close");
        Http.Response res = http.request(ProviderId.HAMROPAY, api + path,
                Http.Options.post(body).withHeaders(headers).withTimeout(cfg.timeout()).withRetries(retries));
        Object code = Js.get(res.data(), "code");
        if (res.status() == 401 || (code instanceof Number n && n.doubleValue() == 16)) {
            throw new PaymentException("Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)",
                    ProviderId.HAMROPAY, "unauthorized", res.status(), res.data());
        }
        if (res.status() != 200 || !(res.data() instanceof Map<?, ?> m)) {
            Object message = Js.get(res.data(), "message");
            String msg = message instanceof String s ? s : Js.slice(res.text(), 200);
            throw new PaymentException("Hamro Pay " + path + " failed: " + msg, ProviderId.HAMROPAY,
                    code != null ? "code_" + Js.string(code) : "http_" + res.status(), res.status(), res.data());
        }
        return Esewa.asMap(m);
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, null, null);
    }

    /**
     * Create Session, then the signed form for the gateway. merchantTxnId = orderId (<= 25 chars).
     * Persist providerRef (the sessionId). A session lives about 10 minutes.
     * A timeout here may still have created the session on Hamro Pay's side: retry with a NEW orderId.
     *
     * @param remarks  form remarks (<= 250 chars); null = description
     * @param metadata sent as-is with Create Session; null = none
     */
    public InitiateResult initiate(InitiateInput input, String remarks, Map<String, String> metadata) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.HAMROPAY);
        if (input.amountPaisa() < MIN_PAISA || input.amountPaisa() > MAX_PAISA) {
            throw new PaymentException("Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", ProviderId.HAMROPAY, "invalid_amount");
        }
        if (!TXN_ID.matcher(input.orderId()).matches()) {
            throw new PaymentException("Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]", ProviderId.HAMROPAY, "invalid_order_id");
        }
        if (gateway == null) throw new IllegalStateException("hamropay: gatewayUrl is required in production (Hamro Pay issues the live gateway host)");
        String transactionAmount = String.valueOf(input.amountPaisa()); // signed and sent as the same string
        String name = input.description().isEmpty() ? "Payment" : input.description();
        Map<String, Object> product = new LinkedHashMap<>();
        product.put("name", name);
        product.put("description", name);
        product.put("price", new BigDecimal(Money.paisaToRupees(input.amountPaisa())));
        product.put("quantity", 1);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchantTxnId", input.orderId());
        body.put("merchantId", cfg.merchantId());
        body.put("transactionAmount", transactionAmount);
        body.put("successRedirectionUrl", input.returnUrl());
        body.put("failedRedirectionUrl", input.failureUrlOrReturnUrl());
        body.put("productList", List.of(product));
        if (input.customer() != null && Js.truthy(input.customer().phone())) body.put("phone_number", input.customer().phone());
        if (metadata != null) body.put("metadata", metadata);
        Map<String, Object> session = post("/v1/checkout/sessionId", body, 0,
                input.orderId(), transactionAmount, cfg.merchantId(), cfg.clientId(), cfg.clientApiKey());
        if (!(session.get("sessionId") instanceof String sessionId) || sessionId.isEmpty()) {
            throw new PaymentException("Hamro Pay: Create Session returned no sessionId", ProviderId.HAMROPAY, "no_session", 200, session);
        }
        Object echoed = session.get("merchantId");
        if (echoed != null && !cfg.merchantId().equals(echoed)) {
            throw new PaymentException("Hamro Pay: Create Session answered for a different merchantId", ProviderId.HAMROPAY, "merchant_mismatch", 200, session);
        }
        String token = sign(cfg.clientSecret(), cfg.merchantId(), input.orderId(), sessionId, transactionAmount, cfg.clientId(), cfg.clientApiKey());
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("merchant_id", cfg.merchantId());
        fields.put("session_id", sessionId);
        fields.put("token", token);
        fields.put("merchant_transaction_id", input.orderId());
        fields.put("remarks", Js.slice(remarks != null ? remarks : input.description(), 250));
        return new InitiateResult.Form(gateway, "POST", fields, null, sessionId);
    }

    /** Get Transaction: authoritative. amount is rupees, and 0 until the payment finishes. */
    @Override
    public VerifyResult verify(VerifyInput input) {
        String orderId = input.orderId();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchantId", cfg.merchantId());
        body.put("merchantTxnId", orderId);
        Map<String, Object> r = post("/v1/checkout/transaction", body, 2, orderId, cfg.merchantId(), cfg.clientId(), cfg.clientApiKey());
        // The reference names it merchantTransactionId; the live API answers merchantTxnId.
        Object echoed = r.get("merchantTransactionId") != null ? r.get("merchantTransactionId") : r.get("merchantTxnId");
        if (echoed != null && !"".equals(echoed) && !Js.string(echoed).equals(orderId)) {
            throw new PaymentException("Hamro Pay: transaction answer is for a different merchantTxnId", ProviderId.HAMROPAY, "id_mismatch", 200, r);
        }
        PaymentStatus status = TXN_STATUS.getOrDefault(Js.stringOrEmpty(r.get("status")).toUpperCase(Locale.ROOT), PaymentStatus.UNKNOWN);
        Long amt = status == PaymentStatus.PAID && r.get("amount") != null ? Money.rupeesToPaisaOf(r.get("amount")) : null;
        Object tracking = r.get("trackingId");
        return new VerifyResult(ProviderId.HAMROPAY, status, orderId, amt,
                tracking instanceof String t && !t.isEmpty() ? t : null, r);
    }

    /** Success and failure redirects carry ?MerchantTxnId=<your orderId>. */
    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("MerchantTxnId");
        if (!Js.truthy(id)) id = params.get("merchantTxnId");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }

    /**
     * Check a webhook's "Signature" header against the parsed JSON body. Hamro Pay signs its own rendering of the amount
     * (a double), which may be "1200", "1200.0" or "1200.00", so every form of the PARSED number is tried. Fulfil only
     * after verify().
     *
     * @throws IllegalStateException when no webhookSecret is configured
     */
    public boolean verifyWebhook(Map<String, ?> body, String signature) {
        if (cfg.webhookSecret() == null || cfg.webhookSecret().isEmpty()) {
            throw new IllegalStateException("hamropay: webhookSecret required to verify webhooks");
        }
        if (signature == null || signature.isEmpty()) return false;
        if (!(body.get("amount") instanceof Number n)) return false;
        double amount = n.doubleValue();
        if (!Double.isFinite(amount)) return false;
        List<String> prefix = new ArrayList<>();
        for (String k : List.of("merchantTxnId", "merchantId", "status")) {
            if (!(body.get(k) instanceof String v) || v.isEmpty() || v.contains(",")) return false;
            prefix.add(v);
        }
        String s = Js.numberToString(amount);
        Set<String> renderings = new LinkedHashSet<>(List.of(s, Js.toFixed(amount, 2), s + ".0", Js.toFixed(amount, 1)));
        boolean ok = false;
        for (String a : renderings) {
            if (Crypto.safeEqual(sign(cfg.webhookSecret(), prefix.get(0), prefix.get(1), prefix.get(2), a), signature)) ok = true;
        }
        return ok;
    }
}
