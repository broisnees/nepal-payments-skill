package np.payments;

import java.security.PrivateKey;
import java.security.PublicKey;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * NEPALPAY QR (NCHL) merchant dynamic QR — https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
 * Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI username/password,
 * and the signing .pfx (NPI.pfx in UAT).
 *
 * <p>Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qrString / qrImage -> customer scans with any
 * NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= providerRef).
 *
 * <p>Token string (comma-joined, no spaces):
 * acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId.
 * Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
 */
public final class NepalPay implements PaymentAdapter {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);
    private static final Pattern BILL_NUMBER = Pattern.compile("[A-Za-z0-9-]{1,25}");
    private static final int NPR = 524;
    private static final Set<String> CREDIT_OK = Set.of("000", "999", "DEFER");

    /** "basic" (merchant QR doc) or "oauth" (NPI password grant, needs clientId/clientSecret). */
    public enum Auth { BASIC, OAUTH }

    /**
     * @param acquirerId           8 digits, e.g. "00002501" (your acquiring bank)
     * @param merchantId           creditor id / merchant code, e.g. "2501ELFDRY2"
     * @param merchantName         <= 25 chars; must match the enrolled name
     * @param terminalLabel        null = "0"
     * @param username             NPI user issued to the merchant; also the userId inside the signed token
     * @param privateKey           signing key from the NPI .pfx (parsed once)
     * @param auth                 null = BASIC
     * @param qrImage              ask NCHL for a base64 PNG alongside the QR string
     * @param nchlPublicKey        NCHL's public key (from NPI.cer): verifies confirm-payment notifications, encrypts the WebSocket api_token
     * @param wsUrl                WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own username and API token
     * @param baseUrl              override; null = default for env
     */
    public record Config(Environment env, String acquirerId, String merchantId, String merchantName, String merchantCategoryCode,
                         String merchantCity, String merchantPostalCode, String storeLabel, String terminalLabel,
                         String username, String password, PrivateKey privateKey, Auth auth, String clientId, String clientSecret,
                         boolean qrImage, PublicKey nchlPublicKey, String wsUrl, String wsUsername, String wsApiToken,
                         String baseUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(acquirerId, "acquirerId");
            Objects.requireNonNull(merchantId, "merchantId");
            Objects.requireNonNull(merchantName, "merchantName");
            Objects.requireNonNull(merchantCategoryCode, "merchantCategoryCode");
            Objects.requireNonNull(merchantCity, "merchantCity");
            Objects.requireNonNull(merchantPostalCode, "merchantPostalCode");
            Objects.requireNonNull(storeLabel, "storeLabel");
            Objects.requireNonNull(username, "username");
            Objects.requireNonNull(password, "password");
            Objects.requireNonNull(privateKey, "privateKey");
            if (auth == null) auth = Auth.BASIC;
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        /** PKCS#8 PEM extracted from the NPI .pfx. Basic auth, qrImage on, terminalLabel "0". */
        public static Config withPem(Environment env, String acquirerId, String merchantId, String merchantName, String merchantCategoryCode,
                                     String merchantCity, String merchantPostalCode, String storeLabel, String username, String password,
                                     String privateKeyPem) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    null, username, password, Crypto.privateKeyFromPem(privateKeyPem), Auth.BASIC, null, null, true,
                    null, null, null, null, null, null);
        }

        public Config withTerminalLabel(String terminalLabel) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        /** NPI OAuth password grant instead of Basic auth. */
        public Config withOAuth(String clientId, String clientSecret) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, Auth.OAUTH, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        public Config withQrImage(boolean qrImage) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        /** NCHL's public key as an SPKI PEM ("BEGIN PUBLIC KEY"); see {@link Crypto#publicKeyFromPem}. */
        public Config withNchlPublicKeyPem(String nchlPublicKeyPem) {
            return withNchlPublicKey(Crypto.publicKeyFromPem(nchlPublicKeyPem));
        }

        public Config withNchlPublicKey(PublicKey nchlPublicKey) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        /** WebSocket channel for {@link NepalPay#webSocketRequest}; also needs the NCHL public key. */
        public Config withWebSocket(String wsUrl, String wsUsername, String wsApiToken) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        public Config withBaseUrl(String baseUrl) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, acquirerId, merchantId, merchantName, merchantCategoryCode, merchantCity, merchantPostalCode, storeLabel,
                    terminalLabel, username, password, privateKey, auth, clientId, clientSecret,
                    qrImage, nchlPublicKey, wsUrl, wsUsername, wsApiToken, baseUrl, timeout);
        }
    }

    private final Config cfg;
    private final Http http;
    private final String base;
    private String cachedToken;
    private long cachedUntil;

    public NepalPay(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public NepalPay(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        this.base = cfg.baseUrl() != null ? cfg.baseUrl()
                : cfg.env() == Environment.SANDBOX ? "https://devopennpi.connectips.com" : "https://opennpi.connectips.com";
    }

    @Override
    public ProviderId id() {
        return ProviderId.NEPALPAY;
    }

    /** The exact string NCHL expects to be signed for a dynamic QR. */
    public static String tokenString(String acquirerId, String merchantId, String merchantCategoryCode, String transactionCurrency,
                                     String transactionAmount, String billNumber, String userId) {
        return String.join(",", acquirerId, merchantId, merchantCategoryCode, transactionCurrency, transactionAmount, billNumber, userId);
    }

    /** What NCHL signs on a confirm-payment notification. The docs name the field payerMobileNumber; the sample sends payerMobile. */
    public static String confirmationString(Map<String, ?> n) {
        String mobile = n.get("payerMobileNumber") != null ? field(n, "payerMobileNumber") : field(n, "payerMobile");
        return String.join(",", field(n, "merchantBillNo"), field(n, "merchantId"), field(n, "merchantName"), field(n, "paymentRef"),
                field(n, "channel"), mobile, field(n, "sessionNo"));
    }

    private static String field(Map<String, ?> n, String k) {
        Object v = n.get(k);
        return v == null ? "" : Js.string(v);
    }

    /** Bearer token cached until 30s before expiry; synchronized so concurrent calls share one grant. */
    private synchronized String authHeader() {
        if (cfg.auth() == Auth.BASIC) return Codec.basicAuth(cfg.username(), cfg.password());
        if (!Js.truthy(cfg.clientId()) || !Js.truthy(cfg.clientSecret())) {
            throw new IllegalStateException("nepalpay: clientId/clientSecret required for auth \"oauth\"");
        }
        if (cachedToken != null && cachedUntil > System.currentTimeMillis()) return "Bearer " + cachedToken;
        Map<String, String> form = new LinkedHashMap<>();
        form.put("grant_type", "password");
        form.put("username", cfg.username());
        form.put("password", cfg.password());
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", Codec.basicAuth(cfg.clientId(), cfg.clientSecret()));
        headers.put("Content-Type", "application/x-www-form-urlencoded");
        Http.Response res = http.request(ProviderId.NEPALPAY, base + "/oauth/token",
                Http.Options.post(Codec.formEncode(form)).withHeaders(headers).withTimeout(cfg.timeout()));
        Object token = Js.get(res.data(), "access_token");
        if (res.status() != 200 || !Js.truthy(token)) {
            throw new PaymentException("NEPALPAY oauth failed: " + Js.slice(res.text(), 200), ProviderId.NEPALPAY, "unauthorized", res.status(), res.data());
        }
        double ttl = Js.toNumber(Js.get(res.data(), "expires_in"));
        if (Double.isNaN(ttl) || ttl == 0) ttl = 60; // Number(expires_in) || 60
        cachedToken = Js.string(token);
        cachedUntil = System.currentTimeMillis() + (long) (Math.max(ttl - 30, 5) * 1000);
        return "Bearer " + cachedToken;
    }

    private Map<String, String> authHeaders() {
        return Map.of("Authorization", authHeader());
    }

    /**
     * Dynamic QR. billNumber = orderId (<= 25 chars). Persist {@code providerRef} (validationTraceId): verify() needs it.
     * returnUrl is unused: there is no redirect, the payer scans the QR from their own app.
     */
    @Override
    public InitiateResult initiate(InitiateInput input) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.NEPALPAY);
        if (!BILL_NUMBER.matcher(input.orderId()).matches()) {
            throw new PaymentException("NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", ProviderId.NEPALPAY, "invalid_order_id");
        }
        // always 2 decimals
        String transactionAmount = input.amountPaisa() / 100 + "." + String.format(Locale.ROOT, "%02d", input.amountPaisa() % 100);
        String token = Crypto.rsaSha256SignBase64(cfg.privateKey(), tokenString(cfg.acquirerId(), cfg.merchantId(), cfg.merchantCategoryCode(),
                Integer.toString(NPR), transactionAmount, input.orderId(), cfg.username()));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("pointOfInitialization", 12);
        body.put("acquirerId", cfg.acquirerId());
        body.put("merchantId", cfg.merchantId());
        body.put("merchantName", Js.slice(cfg.merchantName(), 25));
        body.put("merchantCategoryCode", ConnectIps.jsNumber(cfg.merchantCategoryCode()));
        body.put("merchantCountry", "NP");
        body.put("merchantCity", cfg.merchantCity());
        body.put("merchantPostalCode", cfg.merchantPostalCode());
        body.put("merchantLanguage", "en");
        body.put("transactionCurrency", NPR);
        body.put("transactionAmount", transactionAmount);
        body.put("valueOfConvenienceFeeFixed", "0.00");
        body.put("billNumber", input.orderId());
        body.put("storeLabel", cfg.storeLabel());
        body.put("terminalLabel", cfg.terminalLabel() != null ? cfg.terminalLabel() : "0");
        body.put("purposeOfTransaction", Js.slice(input.description().isEmpty() ? "Payment" : input.description(), 25));
        body.put("qrImage", cfg.qrImage());
        body.put("token", token);
        Http.Response res = http.request(ProviderId.NEPALPAY, base + "/qr/generateQR",
                Http.Options.post(body).withHeaders(authHeaders()).withTimeout(cfg.timeout()));
        Object data = Js.get(res.data(), "data");
        Object qrString = Js.get(data, "qrString");
        Object traceId = Js.get(data, "validationTraceId");
        if (!"000".equals(Js.get(res.data(), "responseCode")) || !Js.truthy(qrString) || !Js.truthy(traceId)) {
            Object code = Js.get(res.data(), "responseCode");
            if (code == null && Js.get(res.data(), "responses") instanceof List<?> l && !l.isEmpty()) code = Js.get(l.get(0), "responseCode");
            throw new PaymentException("NEPALPAY generateQR failed: " + Js.slice(res.text(), 300), ProviderId.NEPALPAY,
                    code != null ? Js.string(code) : "http_" + res.status(), res.status(), res.data());
        }
        Object qrImage = Js.get(data, "qrImage");
        return new InitiateResult.Qr(Js.trim(Js.string(qrString)), Js.truthy(qrImage) ? Js.string(qrImage) : null,
                Js.string(traceId), res.data());
    }

    /** Every payment made against one QR (a failed scan can be retried on the same QR). Non-object rows are dropped. */
    public List<Map<String, Object>> report(String validationTraceId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("validationTraceId", validationTraceId);
        body.put("merchantId", cfg.merchantId());
        body.put("acquirerId", cfg.acquirerId());
        Http.Response res = http.request(ProviderId.NEPALPAY, base + "/nQR/v1/merchanttxnreport",
                Http.Options.post(body).withHeaders(authHeaders()).withTimeout(cfg.timeout()).withRetries(2));
        if (res.status() == 401) throw new PaymentException("NEPALPAY: 401 — wrong NPI username/password", ProviderId.NEPALPAY, "unauthorized", 401, res.data());
        String code = Js.stringOrEmpty(Js.get(res.data(), "responseCode"));
        if (code.equals("E010")) return List.of(); // record not found
        if (!code.equals("200") && !code.equals("000")) {
            throw new PaymentException("NEPALPAY report failed: " + Js.slice(res.text(), 200), ProviderId.NEPALPAY,
                    code.isEmpty() ? "http_" + res.status() : code, res.status(), res.data());
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        if (Js.get(res.data(), "responseBody") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m) rows.add(Esewa.asMap(m));
            }
        }
        return rows;
    }

    /** merchanttxnreport by validationTraceId — authoritative. */
    @Override
    public VerifyResult verify(VerifyInput input) {
        if (!Js.truthy(input.providerRef())) {
            throw new PaymentException("NEPALPAY verify needs providerRef (validationTraceId)", ProviderId.NEPALPAY, "missing_provider_ref");
        }
        List<Map<String, Object>> txns = report(input.providerRef());
        Map<String, Object> paid = null;
        Map<String, Object> last = null;
        for (Map<String, Object> t : txns) {
            Object tranType = t.get("tranType");
            if (!"PMT".equals(tranType != null ? tranType : "PMT")) continue;
            last = t;
            if (paid == null && "000".equals(t.get("debitStatus")) && CREDIT_OK.contains(Js.string(t.get("creditStatus")))) paid = t;
        }
        Map<String, Object> pick = paid != null ? paid : last;
        PaymentStatus status;
        if (paid != null) status = PaymentStatus.PAID;
        else if (pick == null) status = PaymentStatus.NOT_FOUND;
        else if ("000".equals(pick.get("debitStatus"))) status = PaymentStatus.UNKNOWN; // debited but credit not confirmed: review
        else status = PaymentStatus.FAILED;
        Object amount = pick != null ? pick.get("amount") : null;
        Object txnId = pick != null ? pick.get("nQrTxnId") : null;
        return new VerifyResult(ProviderId.NEPALPAY, status, input.orderId(),
                amount != null ? Money.rupeesToPaisaOf(amount) : null, txnId != null ? Js.id(txnId) : null, txns);
    }

    /** Your orderId from a confirm-payment notification (merchantBillNo = the billNumber you sent). */
    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("merchantBillNo");
        if (Js.truthy(id)) return Optional.of(id);
        id = params.get("billNumber");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }

    /** {@link #confirmationResponse(String, String, String, boolean)} with ok = true. */
    public Map<String, String> confirmationResponse(String txnDate, String merchantBillNo, String paymentRef) {
        return confirmationResponse(txnDate, merchantBillNo, paymentRef, true);
    }

    /**
     * Signed reply (serialize with {@link Json#write}) to NCHL's POST {your base}/nepalpay/confirm-payment notification.
     * The notification is a hint: call verify() before fulfilling.
     */
    public Map<String, String> confirmationResponse(String txnDate, String merchantBillNo, String paymentRef, boolean ok) {
        String status = ok ? "SUCCESS" : "FAILED";
        String message = ok ? "TRANSACTION SUCCESSFUL" : "TRANSACTION FAILED";
        Map<String, String> r = new LinkedHashMap<>();
        r.put("txnDate", txnDate);
        r.put("status", status);
        r.put("message", message);
        r.put("merchantBillNo", merchantBillNo);
        r.put("paymentRef", paymentRef);
        r.put("signature", Crypto.rsaSha256SignBase64(cfg.privateKey(), String.join(",", txnDate, status, message, merchantBillNo, paymentRef)));
        return r;
    }

    /**
     * Check a confirm-payment notification's signature with nchlPublicKey. NCHL doesn't say which key signs it, so
     * a false here is a reason to log and alert, not proof of forgery. Fulfil only after verify() either way.
     */
    public boolean verifyConfirmation(Map<String, ?> notification) {
        if (cfg.nchlPublicKey() == null) throw new IllegalStateException("nepalpay: nchlPublicKey required to verify notifications");
        if (!(notification.get("signature") instanceof String sig)) return false;
        return Crypto.rsaSha256VerifyBase64(cfg.nchlPublicKey(), confirmationString(notification), sig);
    }

    /** Everything a STOMP client needs to watch one QR live. {@code body} serializes with {@link Json#write}. */
    public record WebSocketRequest(String url, String subscribe, String send, Map<String, String> body) {}

    /**
     * Connect to {@code url}, subscribe to {@code subscribe}, then send {@code body} as JSON to {@code send}. Statuses
     * arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify(). The api_token is RSA PKCS#1 v1.5
     * encrypted with nchlPublicKey, fresh padding on every call.
     */
    public WebSocketRequest webSocketRequest(String validationTraceId) {
        if (!Js.truthy(cfg.wsUrl()) || !Js.truthy(cfg.wsUsername()) || !Js.truthy(cfg.wsApiToken()) || cfg.nchlPublicKey() == null) {
            throw new IllegalStateException("nepalpay: wsUrl, wsUsername, wsApiToken and nchlPublicKey required for the WebSocket channel");
        }
        Map<String, String> body = new LinkedHashMap<>();
        body.put("merchant_id", cfg.terminalLabel() != null ? cfg.terminalLabel() : "0");
        body.put("request_id", validationTraceId);
        body.put("username", cfg.wsUsername());
        body.put("api_token", Crypto.rsaPkcs1EncryptBase64(cfg.nchlPublicKey(), cfg.wsApiToken()));
        return new WebSocketRequest(cfg.wsUrl(), "/user/nqrws/check-txn-status", "/nqrws/check-txn-status", body);
    }
}
