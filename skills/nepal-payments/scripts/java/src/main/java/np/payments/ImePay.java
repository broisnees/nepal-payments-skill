package np.payments;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * IME Pay web checkout. Source: IME Pay's official WooCommerce + WHMCS plugins. IME Pay merged into Khalti
 * ("Khalti by IME", July 2025): prefer Khalti for new builds; use this for existing IME Pay merchant accounts.
 *
 * <p>Auth: Basic base64(username:password) + header {@code Module: base64(moduleName)}. Callbacks are UNSIGNED, so
 * Recheck is the only proof of payment. Port 7979 must be reachable outbound.
 */
public final class ImePay implements PaymentAdapter {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);

    public record Config(Environment env, String merchantCode, String username, String password, String module,
                         String baseUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(merchantCode, "merchantCode");
            Objects.requireNonNull(username, "username");
            Objects.requireNonNull(password, "password");
            Objects.requireNonNull(module, "module");
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String merchantCode, String username, String password, String module) {
            return new Config(env, merchantCode, username, password, module, null, null);
        }

        public Config withBaseUrl(String baseUrl) {
            return new Config(env, merchantCode, username, password, module, baseUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, merchantCode, username, password, module, baseUrl, timeout);
        }
    }

    private final Config cfg;
    private final Http http;
    private final String base;
    private final Map<String, String> headers;

    public ImePay(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public ImePay(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        this.base = cfg.baseUrl() != null ? cfg.baseUrl()
                : cfg.env() == Environment.SANDBOX ? "https://stg.imepay.com.np:7979" : "https://payment.imepay.com.np:7979";
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", Codec.basicAuth(cfg.username(), cfg.password()));
        h.put("Module", Codec.toBase64(Codec.utf8(cfg.module())));
        this.headers = h;
    }

    @Override
    public ProviderId id() {
        return ProviderId.IMEPAY;
    }

    /** "100.00". */
    private static String amount2dp(long paisa) {
        return paisa / 100 + "." + String.format(Locale.ROOT, "%02d", paisa % 100);
    }

    /**
     * GetToken -> redirect to WebCheckout with a base64 payload. IME POSTs the result (ResponseCode, RefId,
     * TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl. {@code providerRef} = TokenId (persist it).
     */
    @Override
    public InitiateResult initiate(InitiateInput input) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.IMEPAY);
        String amount = amount2dp(input.amountPaisa());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("MerchantCode", cfg.merchantCode());
        body.put("Amount", amount);
        body.put("RefId", input.orderId());
        Http.Response res = http.request(ProviderId.IMEPAY, base + "/api/Web/GetToken", Http.Options.post(body).withHeaders(headers).withTimeout(cfg.timeout()));
        Object token = Js.get(res.data(), "TokenId");
        Object code = Js.get(res.data(), "ResponseCode");
        if (res.status() != 200 || !Js.truthy(token) || !"0".equals(Js.string(code))) {
            Object desc = Js.get(res.data(), "ResponseDescription");
            throw new PaymentException("IME Pay GetToken failed: " + (desc != null ? Js.string(desc) : Js.slice(res.text(), 200)),
                    ProviderId.IMEPAY, "imepay_" + (code != null ? Js.string(code) : String.valueOf(res.status())), res.status(), res.data());
        }
        String tokenId = Js.string(token);
        String payload = String.join("|", tokenId, cfg.merchantCode(), input.orderId(), amount, "POST", input.returnUrl(), input.failureUrlOrReturnUrl());
        return new InitiateResult.Redirect(base + "/WebCheckout/Checkout?data=" + Js.encodeURIComponent(Codec.toBase64(Codec.utf8(payload))),
                tokenId, null, res.data());
    }

    /**
     * Recheck — authoritative. ResponseCode 0 = paid. Other codes are inconsistently documented (1 = failed vs pending),
     * so they stay pending and the reconciliation job escalates at its cutoff. An empty TranAmount gives a null amount.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        if (!Js.truthy(input.providerRef())) throw new PaymentException("IME Pay: stored TokenId required for verify", ProviderId.IMEPAY, "missing_token");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("MerchantCode", cfg.merchantCode());
        body.put("RefId", input.orderId());
        body.put("TokenId", input.providerRef());
        Http.Response res = http.request(ProviderId.IMEPAY, base + "/api/Web/Recheck",
                Http.Options.post(body).withHeaders(headers).withTimeout(cfg.timeout()).withRetries(2));
        if (res.status() != 200 || !(res.data() instanceof Map<?, ?> m) || !m.containsKey("ResponseCode")) {
            throw new PaymentException("IME Pay Recheck failed: " + Js.slice(res.text(), 200), ProviderId.IMEPAY, "http_" + res.status(), res.status(), res.data());
        }
        Map<String, Object> d = Esewa.asMap(m);
        Object refId = d.get("RefId");
        if (Js.truthy(refId) && !input.orderId().equals(refId)) {
            throw new PaymentException("IME Pay: Recheck is for a different RefId", ProviderId.IMEPAY, "callback_mismatch", 400, d);
        }
        boolean paid = "0".equals(Js.string(d.get("ResponseCode")));
        Object tranAmount = d.get("TranAmount");
        Object txn = d.get("TransactionId");
        return new VerifyResult(ProviderId.IMEPAY, paid ? PaymentStatus.PAID : PaymentStatus.PENDING, input.orderId(),
                tranAmount != null && !"".equals(tranAmount) ? Money.rupeesToPaisaOf(tranAmount) : null,
                Js.truthy(txn) ? Js.id(txn) : null, d);
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("RefId");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }
}
