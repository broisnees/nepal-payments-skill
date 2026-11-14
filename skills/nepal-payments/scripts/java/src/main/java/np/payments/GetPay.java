package np.payments;

import java.math.BigDecimal;
import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure). https://getpay.global/web-integration/
 * Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid, tid}), oprKey, insKey (blank when
 * operator-hosted), the bundle URL and the base URL.
 *
 * <p>Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
 * -> onSuccess navigates to the payment page (div#checkout, card form + 3DS)
 * -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
 * -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.
 *
 * <p>merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
 * only counts when the token's oprSecret matches YOUR oprKey and data.clientId is YOUR orderId.
 */
public final class GetPay implements PaymentAdapter {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);
    private static final String SANDBOX_BASE = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions";
    private static final String PRODUCTION_BASE = "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions";
    private static final String BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js";
    private static final Pattern CLIENT_REQUEST_ID = Pattern.compile("[A-Za-z0-9-]{1,50}");
    private static final Pattern NOT_FOUND = Pattern.compile("not found", Pattern.CASE_INSENSITIVE);

    private static final Map<String, PaymentStatus> TXN_STATUS = Map.of(
            "SUCCESS", PaymentStatus.PAID,
            "APPROVED", PaymentStatus.PAID,
            "FAILED", PaymentStatus.FAILED,
            "FAILURE", PaymentStatus.FAILED,
            "DECLINED", PaymentStatus.FAILED,
            "PENDING", PaymentStatus.PENDING,
            "CANCELLED", PaymentStatus.CANCELED,
            "CANCELED", PaymentStatus.CANCELED);

    /**
     * @param papInfo       base64 {"institutionId","mid","tid"} from the bank
     * @param oprKey        operator key from the bank; it also reaches the browser (GetPay's design), so it is not a secret
     * @param insKey        null = ""
     * @param websiteDomain your site origin, e.g. "https://shop.example"; GetPay requires the callback URLs on this host
     * @param imageUrl      logo shown on the checkout page (absolute URL)
     * @param currency      null = "NPR"
     * @param themeColor    null = "#5662FF"
     * @param bundleUrl     null = the v5 bundle on GetPay's CDN
     * @param baseUrl       override; null = default for env
     */
    public record Config(Environment env, String papInfo, String oprKey, String insKey, String websiteDomain, String businessName,
                         String imageUrl, String currency, String themeColor, String bundleUrl, String baseUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(papInfo, "papInfo");
            Objects.requireNonNull(oprKey, "oprKey");
            Objects.requireNonNull(websiteDomain, "websiteDomain");
            Objects.requireNonNull(businessName, "businessName");
            Objects.requireNonNull(imageUrl, "imageUrl");
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String papInfo, String oprKey, String websiteDomain, String businessName, String imageUrl) {
            return new Config(env, papInfo, oprKey, null, websiteDomain, businessName, imageUrl, null, null, null, null, null);
        }

        public Config withInsKey(String insKey) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }

        public Config withCurrency(String currency) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }

        public Config withThemeColor(String themeColor) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }

        public Config withBundleUrl(String bundleUrl) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }

        public Config withBaseUrl(String baseUrl) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, papInfo, oprKey, insKey, websiteDomain, businessName, imageUrl, currency, themeColor, bundleUrl, baseUrl, timeout);
        }
    }

    /** The decoded return token. */
    public record Token(String id, String oprSecret) {}

    private final Config cfg;
    private final Http http;
    private final String base;
    private final String bundleUrl;
    private final String origin;
    private final String currency;

    public GetPay(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public GetPay(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        String b = cfg.baseUrl() != null ? cfg.baseUrl() : cfg.env() == Environment.SANDBOX ? SANDBOX_BASE : PRODUCTION_BASE;
        this.base = b.endsWith("/") ? b.substring(0, b.length() - 1) : b;
        this.bundleUrl = cfg.bundleUrl() != null ? cfg.bundleUrl() : BUNDLE;
        this.origin = origin(cfg.websiteDomain());
        this.currency = cfg.currency() != null ? cfg.currency() : "NPR";
    }

    @Override
    public ProviderId id() {
        return ProviderId.GETPAY;
    }

    /** base64(SHA-256(oprKey + transactionId)): the oprSecret GetPay puts in the return token. */
    public static String oprSecret(String oprKey, String transactionId) {
        return Codec.toBase64(Crypto.sha256(oprKey + transactionId));
    }

    /** Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret". */
    public static Optional<Token> decodeToken(String token) {
        String text;
        try {
            // fromBase64 turns spaces back into "+" before trimming, so pass the token untouched.
            text = Codec.decodeUtf8(Codec.fromBase64(token));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        Object j;
        try {
            j = Json.parse(text);
        } catch (JsonException e) {
            int i = text.indexOf(':');
            return i > 0 && i < text.length() - 1 ? Optional.of(new Token(text.substring(0, i), text.substring(i + 1))) : Optional.empty();
        }
        if (Js.get(j, "id") instanceof String id && Js.get(j, "oprSecret") instanceof String s && !id.isEmpty() && !s.isEmpty()) {
            return Optional.of(new Token(id, s));
        }
        return Optional.empty();
    }

    /** new URL(url).origin for http(s) URLs. */
    private static String origin(String url) {
        URI u;
        try {
            u = new URI(url);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Invalid URL: " + url, e);
        }
        if (u.getScheme() == null || u.getHost() == null) throw new IllegalArgumentException("Invalid URL: " + url);
        String scheme = u.getScheme().toLowerCase(Locale.ROOT);
        int port = u.getPort();
        boolean defaultPort = port == -1 || ("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80);
        return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    private static boolean isNumber(Object v, int n) {
        return v instanceof Number x && x.doubleValue() == n;
    }

    /** POST {base}/{path}; null when GetPay says the transaction is not found. */
    private Map<String, Object> call(String path, Map<String, String> body) {
        Http.Response res = http.request(ProviderId.GETPAY, base + "/" + path,
                Http.Options.post(body).withTimeout(cfg.timeout()).withRetries(2));
        Object d = res.data();
        if (d instanceof Map<?, ?> m && isNumber(m.get("status"), -1) && NOT_FOUND.matcher(Js.string(m.get("message"))).find()) return null;
        if (res.status() != 200 || !(d instanceof Map<?, ?> m) || !isNumber(m.get("status"), 0) || !(m.get("data") instanceof Map<?, ?> data)) {
            Object message = Js.get(d, "message");
            throw new PaymentException("GetPay " + path + " failed: " + (message != null ? Js.string(message) : Js.slice(res.text(), 200)),
                    ProviderId.GETPAY, "http_" + res.status(), res.status(), d);
        }
        return Esewa.asMap(data);
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, null, null);
    }

    /**
     * Options for the browser SDK. clientRequestId = orderId. returnUrl / failureUrl must be on websiteDomain and must
     * serve {@link #returnPage} (the token can arrive in the #hash, which only the browser sees).
     *
     * @param orderInformationUI        HTML shown beside the card form; null = description and amount
     * @param allowBillingAddressFields null = true
     */
    public InitiateResult initiate(InitiateInput input, String orderInformationUI, Boolean allowBillingAddressFields) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.GETPAY);
        if (!CLIENT_REQUEST_ID.matcher(input.orderId()).matches()) {
            throw new PaymentException("GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]", ProviderId.GETPAY, "invalid_order_id");
        }
        String failUrl = input.failureUrlOrReturnUrl();
        for (String u : new String[] {input.returnUrl(), failUrl}) {
            if (!origin(u).equals(origin)) {
                throw new PaymentException("GetPay callback " + u + " must be on websiteDomain " + origin, ProviderId.GETPAY, "invalid_callback_url");
            }
        }
        Customer c = input.customer() != null ? input.customer() : new Customer(null, null, null);
        long p = input.amountPaisa();
        Map<String, Object> userInfo = new LinkedHashMap<>();
        userInfo.put("name", c.name() != null ? c.name() : "");
        userInfo.put("email", c.email() != null ? c.email() : "");
        for (String k : new String[] {"state", "country", "zipcode", "city", "address"}) userInfo.put(k, "");
        Map<String, Object> prefill = new LinkedHashMap<>();
        prefill.put("name", Js.truthy(c.name()));
        prefill.put("email", Js.truthy(c.email()));
        for (String k : new String[] {"state", "city", "address", "zipcode", "country"}) prefill.put(k, false);
        Map<String, Object> callbackUrl = new LinkedHashMap<>();
        callbackUrl.put("successUrl", input.returnUrl());
        callbackUrl.put("failUrl", failUrl);

        Map<String, Object> o = new LinkedHashMap<>();
        o.put("clientRequestId", input.orderId());
        o.put("papInfo", cfg.papInfo());
        o.put("oprKey", cfg.oprKey());
        o.put("insKey", cfg.insKey() != null ? cfg.insKey() : "");
        o.put("websiteDomain", origin);
        o.put("baseUrl", base);
        o.put("price", p / 100.0); // GetPay wants a number, not a string
        o.put("currency", currency);
        o.put("businessName", cfg.businessName());
        o.put("imageUrl", cfg.imageUrl());
        o.put("themeColor", cfg.themeColor() != null ? cfg.themeColor() : "#5662FF");
        o.put("allowBillingAddressFields", allowBillingAddressFields != null ? allowBillingAddressFields : Boolean.TRUE);
        o.put("userInfo", userInfo);
        o.put("prefill", prefill);
        o.put("disableFields", new LinkedHashMap<String, Object>());
        o.put("callbackUrl", callbackUrl);
        o.put("orderInformationUI", orderInformationUI != null ? orderInformationUI
                : "<div style=\"font-family:sans-serif\"><h3>" + Html.escapeHtml(input.description()) + "</h3><p>"
                        + Html.escapeHtml(currency) + " " + BigDecimal.valueOf(p, 2).toPlainString() + "</p></div>");
        return new InitiateResult.Sdk(bundleUrl, o, null);
    }

    /**
     * With callback.token: check oprSecret against oprKey, then merchant-status, then the transaction must carry your
     * orderId. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot prove the
     * transaction is yours, so a success there comes back "unknown" for manual review.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        String orderId = input.orderId();
        String token = input.callback() != null ? input.callback().get("token") : null;
        if (!Js.truthy(token)) {
            Map<String, Object> s = statementByClientRequestId(orderId);
            if (s == null) return new VerifyResult(ProviderId.GETPAY, PaymentStatus.NOT_FOUND, orderId, null, null, null);
            PaymentStatus st = TXN_STATUS.getOrDefault(Js.stringOrEmpty(s.get("status")).toUpperCase(Locale.ROOT), PaymentStatus.UNKNOWN);
            return new VerifyResult(ProviderId.GETPAY, st == PaymentStatus.PAID ? PaymentStatus.UNKNOWN : st, orderId,
                    s.get("saleTransactionAmount") != null ? Money.rupeesToPaisaOf(s.get("saleTransactionAmount")) : null,
                    s.get("transactionId") instanceof String id ? id : null, s);
        }
        Token t = decodeToken(token).orElseThrow(() ->
                new PaymentException("GetPay: return token is not base64 {id, oprSecret}", ProviderId.GETPAY, "malformed_callback", 400, null));
        if (!Crypto.safeEqual(oprSecret(cfg.oprKey(), t.id()), t.oprSecret())) {
            throw new PaymentException("GetPay: oprSecret does not match oprKey + id", ProviderId.GETPAY, "bad_signature", 400, Map.of("id", t.id()));
        }
        Map<String, Object> d = status(t.id());
        if (d == null) return new VerifyResult(ProviderId.GETPAY, PaymentStatus.NOT_FOUND, orderId, null, t.id(), null);
        if (!Js.stringOrEmpty(d.get("clientId")).equals(orderId)) {
            throw new PaymentException("GetPay: transaction belongs to a different clientRequestId", ProviderId.GETPAY, "id_mismatch", 400, d);
        }
        return new VerifyResult(ProviderId.GETPAY,
                TXN_STATUS.getOrDefault(Js.stringOrEmpty(d.get("status")).toUpperCase(Locale.ROOT), PaymentStatus.UNKNOWN), orderId,
                d.get("amount") != null ? Money.rupeesToPaisaOf(d.get("amount")) : null, t.id(), d);
    }

    /** merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks}; null if unknown. */
    public Map<String, Object> status(String transactionId) {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("id", transactionId);
        body.put("papInfo", cfg.papInfo());
        return call("merchant-status", body);
    }

    /** transaction-statement by GetPay transaction id: payer, masked PAN, scheme, stan, crrn; null if unknown. */
    public Map<String, Object> statementByTransactionId(String transactionId) {
        return call("transaction-statement", Map.of("transactionId", transactionId));
    }

    /** transaction-statement by your clientRequestId (orderId); null if unknown. */
    public Map<String, Object> statementByClientRequestId(String clientRequestId) {
        return call("transaction-statement", Map.of("clientRequestId", clientRequestId));
    }

    /** The orderId is in YOUR return URL path (GetPay adds only the token); extract it from the route instead. */
    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("clientRequestId");
        if (!Js.truthy(id)) id = params.get("orderId");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }

    /** JSON for a script element: "<" escaped so no value can close the element. */
    private static String scriptJson(Object v) {
        return (v instanceof String s ? Json.quote(s) : Json.write(v)).replace("<", "\\u003c");
    }

    /** Page 1: loads the bundle and starts checkout; onSuccess opens {@code paymentPageUrl}. */
    public String checkoutPage(InitiateResult.Sdk r, String paymentPageUrl) {
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Checkout</title>\n"
                + "<script defer src=\"" + Html.escapeHtml(r.scriptUrl()) + "\"></script></head><body><div id=\"checkout\" hidden></div><noscript>JavaScript is required to pay by card.</noscript>\n"
                + "<script>window.addEventListener(\"load\",function(){var o=" + scriptJson(r.options()) + ";o.onSuccess=function(){location.href="
                + scriptJson(paymentPageUrl) + "};o.onError=function(e){document.body.insertAdjacentHTML(\"beforeend\",\"<p>Card checkout could not start. Please try again.</p>\");console.error(e)};new GetPay(o).initialize()});</script></body></html>";
    }

    /** Page 2: GetPay renders the card form into #checkout. */
    public String paymentPage() {
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Pay by card</title>\n"
                + "<script defer src=\"" + Html.escapeHtml(bundleUrl) + "\"></script></head><body><div id=\"checkout\"></div></body></html>";
    }

    /**
     * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the query or the
     * #hash, and send it to {@code verifyUrl} as ?token=. Your server then calls verify() with callback token.
     */
    public String returnPage(String verifyUrl) {
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Confirming payment</title></head><body><p>Confirming your payment...</p>\n"
                + "<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{var h=location.hash||\"\",q=new URLSearchParams(location.search);"
                + "var t=q.get(\"token\")||new URLSearchParams(h.indexOf(\"?\")>=0?h.slice(h.indexOf(\"?\")+1):h.replace(/^#/,\"\")).get(\"token\");var u=new URL("
                + scriptJson(verifyUrl) + ",location.href);if(t)u.searchParams.set(\"token\",t);location.replace(u.toString())}</script></body></html>";
    }
}
