package np.payments;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.StringJoiner;
import java.util.regex.Pattern;

/**
 * Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/
 *
 * <p>Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url -> lookup (server) with
 * the pidx YOU stored -> fulfil only on "Completed".
 */
public final class Khalti implements PaymentAdapter {
    private static final Pattern KEY_PREFIX = Pattern.compile("^key" + Js.WS + "+", Pattern.CASE_INSENSITIVE);

    private static final Map<String, PaymentStatus> STATUS = Map.of(
            "completed", PaymentStatus.PAID,
            "pending", PaymentStatus.PENDING,
            "initiated", PaymentStatus.PENDING, // user hasn't paid yet; Khalti flips it to Expired after the link expires
            "refunded", PaymentStatus.REFUNDED,
            "partially refunded", PaymentStatus.PARTIALLY_REFUNDED,
            "expired", PaymentStatus.EXPIRED,
            "user canceled", PaymentStatus.CANCELED,
            "failed", PaymentStatus.FAILED);

    /**
     * @param secretKey  "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com (production)
     * @param websiteUrl your site's public URL (required by Khalti)
     */
    public record Config(Environment env, String secretKey, String websiteUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            if (timeout == null) timeout = Http.DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String secretKey, String websiteUrl) {
            return new Config(env, secretKey, websiteUrl, null);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, secretKey, websiteUrl, timeout);
        }
    }

    /** Must sum to amountPaisa or Khalti returns "Amount Breakdown mismatch". */
    public record AmountBreakdown(String label, long amount) {}

    public record ProductDetail(String identity, String name, long totalPrice, long quantity, long unitPrice) {}

    /**
     * Optional initiate fields (each nullable).
     *
     * @param merchantExtras keys must start with "merchant_"; echoed back in the success payload
     */
    public record Extras(List<AmountBreakdown> amountBreakdown, List<ProductDetail> productDetails, Map<String, String> merchantExtras) {
        public static final Extras NONE = new Extras(null, null, null);
    }

    private final Config cfg;
    private final Http http;
    private final String host;
    private final String base;
    private final Map<String, String> auth;

    public Khalti(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public Khalti(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        if (cfg.secretKey() == null || cfg.secretKey().isEmpty()) throw new IllegalArgumentException("khalti: secretKey is required");
        this.http = new Http(transport);
        this.host = cfg.env() == Environment.SANDBOX ? "https://dev.khalti.com" : "https://khalti.com";
        this.base = host + "/api/v2";
        this.auth = Map.of("Authorization", "Key " + KEY_PREFIX.matcher(cfg.secretKey()).replaceFirst(""));
    }

    @Override
    public ProviderId id() {
        return ProviderId.KHALTI;
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, Extras.NONE);
    }

    /** Redirect to Khalti. {@code providerRef} = pidx: PERSIST IT (lookup needs it; there is no lookup-by-order-id). */
    public InitiateResult initiate(InitiateInput input, Extras extras) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.KHALTI);
        if (input.amountPaisa() < 1000) {
            throw new PaymentException("Khalti minimum is Rs 10 (1000 paisa)", ProviderId.KHALTI, "amount_too_low");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("return_url", input.returnUrl());
        body.put("website_url", cfg.websiteUrl());
        body.put("amount", input.amountPaisa()); // integer paisa
        body.put("purchase_order_id", input.orderId());
        body.put("purchase_order_name", Js.slice(input.description(), 255));
        if (input.customer() != null) body.put("customer_info", input.customer().toJson());
        if (extras.amountBreakdown() != null) {
            List<Object> l = new ArrayList<>();
            for (AmountBreakdown a : extras.amountBreakdown()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("label", a.label());
                m.put("amount", a.amount());
                l.add(m);
            }
            body.put("amount_breakdown", l);
        }
        if (extras.productDetails() != null) {
            List<Object> l = new ArrayList<>();
            for (ProductDetail p : extras.productDetails()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("identity", p.identity());
                m.put("name", p.name());
                m.put("total_price", p.totalPrice());
                m.put("quantity", p.quantity());
                m.put("unit_price", p.unitPrice());
                l.add(m);
            }
            body.put("product_details", l);
        }
        if (extras.merchantExtras() != null) {
            extras.merchantExtras().forEach((k, v) -> {
                if (!k.startsWith("merchant_")) throw new IllegalArgumentException("Khalti merchant extras must start with \"merchant_\": " + k);
                body.put(k, v);
            });
        }
        // Trailing slash is REQUIRED: without it Khalti 301s and the POST body is lost. No retries: not idempotent.
        Http.Response res = http.request(ProviderId.KHALTI, base + "/epayment/initiate/",
                Http.Options.post(body).withHeaders(auth).withTimeout(cfg.timeout()));
        if (res.status() != 200 || !Js.truthy(Js.get(res.data(), "pidx"))) {
            throw new PaymentException(errorMessage(res.data()), ProviderId.KHALTI, errorKey(res.data(), res.status()), res.status(), res.data());
        }
        Object expires = Js.get(res.data(), "expires_at");
        return new InitiateResult.Redirect(Js.stringOrEmpty(Js.get(res.data(), "payment_url")), Js.string(Js.get(res.data(), "pidx")),
                expires == null ? null : Js.string(expires), res.data());
    }

    /**
     * Lookup with the pidx stored at initiate time ({@code providerRef}). The lookup response has no purchase_order_id,
     * so a callback pidx that differs from the stored one is rejected (replay guard). Expired / User canceled arrive as
     * HTTP 400 with a normal body and map to a status.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        String pidx = input.providerRef();
        if (!Js.truthy(pidx)) throw new PaymentException("khalti: stored pidx required for verify", ProviderId.KHALTI, "missing_pidx");
        String cbPidx = input.callback() == null ? null : input.callback().get("pidx");
        if (Js.truthy(cbPidx) && !cbPidx.equals(pidx)) {
            throw new PaymentException("khalti: callback pidx does not match stored pidx", ProviderId.KHALTI, "pidx_mismatch", 400, input.callback());
        }
        Http.Response res = http.request(ProviderId.KHALTI, base + "/epayment/lookup/",
                Http.Options.post(Map.of("pidx", pidx)).withHeaders(auth).withTimeout(cfg.timeout()).withRetries(2));
        if (res.data() instanceof Map<?, ?> d && d.get("status") instanceof String s) {
            PaymentStatus status = STATUS.getOrDefault(s.toLowerCase(Locale.ROOT), PaymentStatus.UNKNOWN);
            return new VerifyResult(ProviderId.KHALTI, status, input.orderId(), integralPaisa(d.get("total_amount")),
                    Js.id(d.get("transaction_id")), res.data());
        }
        if (res.status() == 404 || "Not found.".equals(Js.get(res.data(), "detail"))) {
            return new VerifyResult(ProviderId.KHALTI, PaymentStatus.NOT_FOUND, input.orderId(), null, null, res.data());
        }
        throw new PaymentException(errorMessage(res.data()), ProviderId.KHALTI, errorKey(res.data(), res.status()), res.status(), res.data());
    }

    /** JSON number -> Long; a non-integral amount can't be paisa, so it reads as "no amount" (-> review if paid). */
    private static Long integralPaisa(Object v) {
        if (!(v instanceof BigDecimal d)) return null;
        try {
            return d.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("purchase_order_id");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }

    /** Full refund of a completed transaction (transaction_id from lookup). */
    public Object refund(String transactionId) {
        return refund(transactionId, null, null);
    }

    /**
     * Refund. Full refund when amountPaisa is null. {@code mobile} is required for payments made via bank/e-banking.
     * Khalti's docs say partial refund {@code amount} is paisa but their example shows "50.00": confirm the unit in
     * sandbox before relying on partial refunds.
     */
    public Object refund(String transactionId, Long amountPaisa, String mobile) {
        Map<String, Object> body = new LinkedHashMap<>();
        if (amountPaisa != null) {
            Money.assertPaisa(amountPaisa, ProviderId.KHALTI);
            body.put("amount", amountPaisa);
        }
        if (Js.truthy(mobile)) body.put("mobile", mobile);
        Http.Response res = http.request(ProviderId.KHALTI, host + "/api/merchant-transaction/" + Js.encodeURIComponent(transactionId) + "/refund/",
                Http.Options.post(body).withHeaders(auth).withTimeout(cfg.timeout()));
        if (res.status() != 200) {
            throw new PaymentException(errorMessage(res.data()), ProviderId.KHALTI, errorKey(res.data(), res.status()), res.status(), res.data());
        }
        return res.data();
    }

    private static String errorKey(Object data, int status) {
        if (status == 401) return "unauthorized";
        Object k = Js.get(data, "error_key");
        return Js.truthy(k) ? Js.string(k) : "http_" + status;
    }

    private static String errorMessage(Object data) {
        if (!(data instanceof Map) && !(data instanceof List)) return "Khalti error: " + Js.slice(Js.string(data), 200);
        Object detail = Js.get(data, "detail");
        if (Js.truthy(detail)) return "Khalti: " + Js.string(detail);
        StringJoiner fields = new StringJoiner("; ");
        if (data instanceof Map<?, ?> m) {
            m.forEach((k, v) -> {
                if (!"error_key".equals(k) && !"status_code".equals(k)) {
                    fields.add(k + ": " + (v instanceof List<?> l ? Js.join(l, " ") : Js.string(v)));
                }
            });
        } else {
            List<?> l = (List<?>) data;
            for (int i = 0; i < l.size(); i++) fields.add(i + ": " + (l.get(i) instanceof List<?> x ? Js.join(x, " ") : Js.string(l.get(i))));
        }
        return "Khalti: " + (fields.length() == 0 ? "unknown error" : fields.toString());
    }
}
