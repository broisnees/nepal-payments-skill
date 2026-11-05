package np.payments;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Nepal Payment Solution (NPS / NPX) OnePG — one integration routes to ~29 banks' mobile/e-banking, card checkout and
 * wallets. Source: "DEVELOPER GUIDELINES – API DOCUMENT – GATEWAY 2025" (given to merchants at onboarding).
 *
 * <p>Auth: Basic base64(apiUsername:apiPassword). Signature: HMAC-SHA512(secretKey, values of payload keys sorted
 * alphabetically (excluding Signature), concatenated with NO separator) as lowercase hex.
 *
 * <p>Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> payer pays -> NPS GETs your Notification
 * URL + browser returns to ResponseUrl -> CheckTransactionStatus (authoritative).
 */
public final class Nps implements PaymentAdapter {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);
    private static final Map<String, PaymentStatus> STATUS = Map.of(
            "success", PaymentStatus.PAID, "fail", PaymentStatus.FAILED, "failed", PaymentStatus.FAILED, "pending", PaymentStatus.PENDING);

    public record Config(Environment env, String merchantId, String merchantName, String apiUsername, String apiPassword,
                         String secretKey, String apiBaseUrl, String gatewayUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(merchantId, "merchantId");
            Objects.requireNonNull(merchantName, "merchantName");
            Objects.requireNonNull(apiUsername, "apiUsername");
            Objects.requireNonNull(apiPassword, "apiPassword");
            Objects.requireNonNull(secretKey, "secretKey");
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String merchantId, String merchantName, String apiUsername, String apiPassword, String secretKey) {
            return new Config(env, merchantId, merchantName, apiUsername, apiPassword, secretKey, null, null, null);
        }

        public Config withUrls(String apiBaseUrl, String gatewayUrl) {
            return new Config(env, merchantId, merchantName, apiUsername, apiPassword, secretKey, apiBaseUrl, gatewayUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, merchantId, merchantName, apiUsername, apiPassword, secretKey, apiBaseUrl, gatewayUrl, timeout);
        }
    }

    private final Config cfg;
    private final Http http;
    private final String api;
    private final String gateway;
    private final Map<String, String> auth;

    public Nps(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public Nps(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        boolean sandbox = cfg.env() == Environment.SANDBOX;
        this.api = cfg.apiBaseUrl() != null ? cfg.apiBaseUrl() : sandbox ? "https://apisandbox.nepalpayment.com" : "https://apigateway.nepalpayment.com";
        this.gateway = cfg.gatewayUrl() != null ? cfg.gatewayUrl()
                : sandbox ? "https://gatewaysandbox.nepalpayment.com/Payment/Index" : "https://gateway.nepalpayment.com/Payment/Index";
        this.auth = Map.of("Authorization", Codec.basicAuth(cfg.apiUsername(), cfg.apiPassword()));
    }

    @Override
    public ProviderId id() {
        return ProviderId.NPS;
    }

    /** Sorted-keys, no-separator HMAC-SHA512 (lowercase hex). "Signature" is excluded. */
    public static String sign(String secretKey, Map<String, String> payload) {
        StringBuilder message = new StringBuilder();
        payload.keySet().stream().filter(k -> !k.equals("Signature")).sorted().forEach(k -> {
            String v = payload.get(k);
            if (v != null) message.append(v);
        });
        return Codec.toHex(Crypto.hmac(Crypto.Hash.SHA_512, secretKey, message.toString()));
    }

    private Map<String, String> merchant() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("MerchantId", cfg.merchantId());
        m.put("MerchantName", cfg.merchantName());
        return m;
    }

    private Map<String, Object> call(String path, Map<String, String> payload, int retries) {
        Map<String, Object> body = new LinkedHashMap<>(payload);
        body.put("Signature", sign(cfg.secretKey(), payload));
        Http.Response res = http.request(ProviderId.NPS, api + "/" + path,
                Http.Options.post(body).withHeaders(auth).withTimeout(cfg.timeout()).withRetries(retries));
        if (res.status() == 401) throw new PaymentException("NPS: 401 — wrong API username/password", ProviderId.NPS, "unauthorized", 401, null);
        if (res.status() != 200 || !(res.data() instanceof Map<?, ?> m) || !m.containsKey("code")) {
            throw new PaymentException("NPS " + path + " failed: " + Js.slice(res.text(), 200), ProviderId.NPS, "http_" + res.status(), res.status(), res.data());
        }
        return Esewa.asMap(m);
    }

    private static PaymentException fail(String path, Map<String, Object> r) {
        List<Object> messages = new ArrayList<>();
        Object firstCode = null;
        if (r.get("errors") instanceof List<?> errors) {
            for (Object e : errors) messages.add(Js.get(e, "error_message"));
            if (!errors.isEmpty()) firstCode = Js.get(errors.get(0), "error_code");
        }
        String joined = Js.join(messages, "; ");
        return new PaymentException("NPS " + path + ": " + (joined.isEmpty() ? Js.string(r.get("message")) : joined), ProviderId.NPS,
                Js.truthy(firstCode) ? "nps_" + Js.string(firstCode) : "nps_error", 200, r);
    }

    /** Optional: banks/wallets for your own picker; pass the chosen InstrumentCode to initiate(). */
    public List<Map<String, Object>> getInstruments() {
        Map<String, Object> r = call("GetPaymentInstrumentDetails", merchant(), 2);
        if (!"0".equals(r.get("code"))) throw fail("GetPaymentInstrumentDetails", r);
        List<Map<String, Object>> out = new ArrayList<>();
        if (r.get("data") instanceof List<?> l) {
            for (Object o : l) {
                if (!(o instanceof Map<?, ?> m)) throw new PaymentException("NPS GetPaymentInstrumentDetails: unexpected data", ProviderId.NPS, "malformed_response", 200, r);
                out.add(Esewa.asMap(m));
            }
            return out;
        }
        throw new PaymentException("NPS GetPaymentInstrumentDetails: unexpected data", ProviderId.NPS, "malformed_response", 200, r);
    }

    /** Optional: NPS service charge for an amount + instrument (Amount, CommissionType, ChargeValue, TotalChargeAmount). */
    public Map<String, Object> getServiceCharge(long amountPaisa, String instrumentCode) {
        Map<String, String> payload = merchant();
        payload.put("Amount", Money.paisaToRupees(amountPaisa));
        payload.put("InstrumentCode", instrumentCode);
        Map<String, Object> r = call("GetServiceCharge", payload, 2);
        if (!"0".equals(r.get("code"))) throw fail("GetServiceCharge", r);
        if (!(r.get("data") instanceof Map<?, ?> m)) throw new PaymentException("NPS GetServiceCharge: unexpected data", ProviderId.NPS, "malformed_response", 200, r);
        return Esewa.asMap(m);
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, null);
    }

    /**
     * GetProcessId + gateway form (multipart/form-data). {@code providerRef} = ProcessId (persist it). The Notification
     * URL is configured with NPS at onboarding, not per request.
     *
     * @param instrumentCode skips NPS's picker page; nullable
     */
    public InitiateResult initiate(InitiateInput input, String instrumentCode) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.NPS);
        String amount = Money.paisaToRupees(input.amountPaisa()); // the SAME string in GetProcessId and the form
        Map<String, String> payload = merchant();
        payload.put("Amount", amount);
        payload.put("MerchantTxnId", input.orderId());
        Map<String, Object> r = call("GetProcessId", payload, 0);
        Object processId = Js.get(r.get("data"), "ProcessId");
        if (!"0".equals(r.get("code")) || !Js.truthy(processId)) throw fail("GetProcessId", r);
        String pid = Js.string(processId);
        Map<String, String> f = merchant();
        f.put("Amount", amount);
        f.put("MerchantTxnId", input.orderId());
        f.put("ProcessId", pid);
        f.put("TransactionRemarks", Js.slice(input.description(), 100));
        f.put("ResponseUrl", input.returnUrl());
        if (Js.truthy(instrumentCode)) f.put("InstrumentCode", instrumentCode);
        return new InitiateResult.Form(gateway, "POST", f, "multipart/form-data", pid);
    }

    /**
     * CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API error; error_code "3"
     * ("Transaction not initialized yet") is not_found.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        Map<String, String> payload = merchant();
        payload.put("MerchantTxnId", input.orderId());
        Map<String, Object> r = call("CheckTransactionStatus", payload, 2);
        if (!"0".equals(r.get("code"))) {
            if (r.get("errors") instanceof List<?> errors && errors.stream().anyMatch(e -> "3".equals(Js.get(e, "error_code")))) {
                return new VerifyResult(ProviderId.NPS, PaymentStatus.NOT_FOUND, input.orderId(), null, null, r);
            }
            throw fail("CheckTransactionStatus", r);
        }
        // code "0" with a null/non-object data is malformed; report it as unknown rather than throw.
        Object data = r.get("data") instanceof Map<?, ?> m ? m : Map.of();
        Object txn = Js.get(data, "MerchantTxnId");
        if (Js.truthy(txn) && !input.orderId().equals(txn)) {
            throw new PaymentException("NPS: status is for a different transaction", ProviderId.NPS, "callback_mismatch", 400, data);
        }
        Object amount = Js.get(data, "Amount");
        return new VerifyResult(ProviderId.NPS,
                STATUS.getOrDefault(Js.stringOrEmpty(Js.get(data, "Status")).toLowerCase(Locale.ROOT), PaymentStatus.UNKNOWN),
                input.orderId(),
                Js.truthy(amount) ? Money.rupeesToPaisaOf(amount) : null, // excludes ServiceCharge
                Js.id(Js.get(data, "GatewayReferenceNo")),
                r);
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("MerchantTxnId");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }

    /**
     * Plain-text body for your Notification URL handler, AFTER you've verified + recorded a FINAL status: "received" the
     * first time, "already received" for repeats. While still pending, return a non-2xx instead so NPS retries.
     */
    public String notificationResponse(boolean alreadyProcessed) {
        return alreadyProcessed ? "already received" : "received";
    }
}
