package np.payments;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fonepay — web payment (redirect) + Dynamic QR. Source: "Technical Specification Document (Fonepay Web Integration)
 * v2.0" + Dynamic QR spec v1.1 (2024). Credentials come from your acquiring bank / Fonepay merchant onboarding.
 *
 * <p>Signatures: HMAC-SHA512(secretKey UTF-8, comma-joined values) as HEX, compared case-insensitively.
 * <pre>
 *   request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
 *   response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
 *   txnVerification  = username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,&lt;exact JSON body&gt;
 *   QR create        = amount,prn,merchantCode,remarks1,remarks2
 *   QR status        = prn,merchantCode
 * </pre>
 */
public final class Fonepay implements PaymentAdapter {
    private static final ZoneId KATHMANDU = ZoneId.of("Asia/Kathmandu");
    private static final DateTimeFormatter DT = DateTimeFormatter.ofPattern("MM/dd/uuuu", Locale.ROOT);
    private static final String TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification";
    private static final List<String> RESPONSE_DV_FIELDS = List.of("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT");
    private static final Map<String, PaymentStatus> TXN_STATUS = Map.of(
            "success", PaymentStatus.PAID, "pending", PaymentStatus.PENDING, "failed", PaymentStatus.FAILED);

    /**
     * @param merchantCode PID (3–20 chars). Public dev sample: "NBQM"
     * @param secretKey    HMAC secret from the merchant profile page. Public dev sample: "a7e3512f5032480a83137793cb2021dc"
     * @param username     merchant-panel login, required for txnVerification (recommended) and Dynamic QR; nullable
     * @param password     nullable
     */
    public record Config(Environment env, String merchantCode, String secretKey, String username, String password,
                         String paymentUrl, String txnVerificationUrl, String legacyVerifyUrl, String qrBaseUrl,
                         boolean strictSignature, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(merchantCode, "merchantCode");
            Objects.requireNonNull(secretKey, "secretKey");
            if (timeout == null) timeout = Http.DEFAULT_TIMEOUT;
        }

        public static Config of(Environment env, String merchantCode, String secretKey) {
            return new Config(env, merchantCode, secretKey, null, null, null, null, null, null, true, null);
        }

        public Config withLogin(String username, String password) {
            return new Config(env, merchantCode, secretKey, username, password, paymentUrl, txnVerificationUrl, legacyVerifyUrl, qrBaseUrl, strictSignature, timeout);
        }

        /** Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank); null = default. */
        public Config withUrls(String paymentUrl, String txnVerificationUrl, String legacyVerifyUrl, String qrBaseUrl) {
            return new Config(env, merchantCode, secretKey, username, password, paymentUrl, txnVerificationUrl, legacyVerifyUrl, qrBaseUrl, strictSignature, timeout);
        }

        public Config withStrictSignature(boolean strictSignature) {
            return new Config(env, merchantCode, secretKey, username, password, paymentUrl, txnVerificationUrl, legacyVerifyUrl, qrBaseUrl, strictSignature, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, merchantCode, secretKey, username, password, paymentUrl, txnVerificationUrl, legacyVerifyUrl, qrBaseUrl, strictSignature, timeout);
        }
    }

    /** Render {@code qrMessage} as a QR code; listen on {@code webSocketUrl} (nullable) or poll qrStatus(). */
    public record QrCreated(String qrMessage, String webSocketUrl, Object raw) {}

    private final Config cfg;
    private final Http http;
    private final String paymentUrl;
    private final String legacyVerifyUrl;
    private final String txnVerificationUrl;
    private final String qrBaseUrl;

    public Fonepay(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public Fonepay(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        boolean sandbox = cfg.env() == Environment.SANDBOX;
        String client = sandbox ? "https://dev-clientapi.fonepay.com" : "https://clientapi.fonepay.com";
        // Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on onboarding).
        String merchant = (sandbox ? "https://dev-merchantapi.fonepay.com" : "https://merchantapi.fonepay.com") + "/api/merchant/merchantDetailsForThirdParty";
        this.paymentUrl = cfg.paymentUrl() != null ? cfg.paymentUrl() : client + "/api/merchantRequest";
        this.legacyVerifyUrl = cfg.legacyVerifyUrl() != null ? cfg.legacyVerifyUrl() : client + "/api/merchantRequest/verificationMerchant";
        this.txnVerificationUrl = cfg.txnVerificationUrl() != null ? cfg.txnVerificationUrl() : merchant + "/txnVerification";
        this.qrBaseUrl = cfg.qrBaseUrl() != null ? cfg.qrBaseUrl() : merchant;
    }

    @Override
    public ProviderId id() {
        return ProviderId.FONEPAY;
    }

    /** Uppercase hex HMAC-SHA512 over the comma-joined values. */
    public static String hmac(String secret, List<String> values) {
        return Codec.toHex(Crypto.hmac(Crypto.Hash.SHA_512, secret, String.join(",", values))).toUpperCase(Locale.ROOT);
    }

    /** MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats). */
    public static String date(Instant at) {
        return DT.format(at.atZone(KATHMANDU));
    }

    public static String date() {
        return date(Instant.now());
    }

    private boolean loggedIn() {
        return Js.truthy(cfg.username()) && Js.truthy(cfg.password());
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, null);
    }

    /**
     * Redirect URL for the Fonepay web payment page. PRN = orderId (3–25 chars). Keep returnUrl (RU) <= 150 chars and
     * free of query strings.
     *
     * @param remarks2 R2 (max 50 chars); null = "N/A"
     */
    public InitiateResult initiate(InitiateInput input, String remarks2) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.FONEPAY);
        if (input.orderId().length() < 3 || input.orderId().length() > 25) {
            throw new PaymentException("Fonepay PRN must be 3–25 chars", ProviderId.FONEPAY, "invalid_order_id");
        }
        if (input.returnUrl().length() > 150) throw new PaymentException("Fonepay RU must be <= 150 chars", ProviderId.FONEPAY, "invalid_return_url");
        String r1 = Js.slice(input.description(), 160);
        String r2 = Js.slice(remarks2 != null ? remarks2 : "N/A", 50);
        Map<String, String> p = new LinkedHashMap<>();
        p.put("PID", cfg.merchantCode());
        p.put("MD", "P");
        p.put("PRN", input.orderId());
        p.put("AMT", Money.paisaToRupees(input.amountPaisa())); // rupees; the SAME string goes into DV
        p.put("CRN", "NPR");
        p.put("DT", date());
        p.put("R1", r1.isEmpty() ? "Payment" : r1);
        p.put("R2", r2.isEmpty() ? "N/A" : r2);
        p.put("RU", input.returnUrl());
        p.put("DV", hmac(cfg.secretKey(), new ArrayList<>(p.values()))); // raw (not URL-encoded) values
        return new InitiateResult.Redirect(paymentUrl + "?" + Codec.formEncode(p));
    }

    /** True only when DV is present and matches PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT (case-insensitive hex). */
    public boolean callbackValid(Map<String, String> params) {
        String dv = params.get("DV");
        if (!Js.truthy(dv)) return false;
        List<String> values = new ArrayList<>();
        for (String f : RESPONSE_DV_FIELDS) values.add(params.getOrDefault(f, ""));
        return Crypto.safeEqual(hmac(cfg.secretKey(), values), dv.toUpperCase(Locale.ROOT));
    }

    /**
     * Authoritative check. Uses txnVerification when username/password are configured (works without a callback, so
     * the reconciliation job can use it). Otherwise falls back to the legacy GET verification, which needs UID + BC from
     * a DV-verified redirect. Callback params are trusted ONLY with a valid DV: a missing DV counts as invalid
     * (strict mode throws invalid_signature), so nobody can force "failed" with ?PRN=..&amp;PS=false.
     */
    @Override
    public VerifyResult verify(VerifyInput input) {
        Map<String, String> callback = input.callback();
        Map<String, String> trusted = null;
        if (callback != null && callback.keySet().stream().anyMatch(k -> k.equals("DV") || RESPONSE_DV_FIELDS.contains(k))) {
            if (callbackValid(callback)) {
                if (!Objects.equals(callback.get("PRN"), input.orderId()) || !Objects.equals(callback.get("PID"), cfg.merchantCode())) {
                    throw new PaymentException("Fonepay: callback does not match this attempt", ProviderId.FONEPAY, "callback_mismatch", 400, callback);
                }
                trusted = callback;
            } else if (cfg.strictSignature()) {
                throw new PaymentException("Fonepay: missing or invalid response DV", ProviderId.FONEPAY, "invalid_signature", 400, callback);
            }
        }

        if (loggedIn()) {
            Map<String, Object> r = txnVerification(input.orderId(), input.amountPaisa());
            Object requested = r.get("requestedAmount");
            Object trace = r.get("fonepayTraceId");
            return new VerifyResult(ProviderId.FONEPAY,
                    TXN_STATUS.getOrDefault(((String) r.get("paymentStatus")).toLowerCase(Locale.ROOT), PaymentStatus.UNKNOWN),
                    input.orderId(),
                    Js.truthy(requested) ? Money.rupeesToPaisaOf(requested) : null,
                    trace != null ? Js.id(trace) : trusted != null ? trusted.get("UID") : null,
                    r);
        }

        if (trusted != null && Js.truthy(trusted.get("UID")) && Js.truthy(trusted.get("BC"))) {
            String uid = trusted.get("UID");
            // Authentic (DV-verified) negative outcome from Fonepay.
            if (!"true".equals(trusted.get("PS")) || !"successful".equals(trusted.get("RC"))) {
                PaymentStatus status = "cancel".equals(trusted.get("RC")) ? PaymentStatus.CANCELED : PaymentStatus.FAILED;
                return new VerifyResult(ProviderId.FONEPAY, status, input.orderId(), null, uid, trusted);
            }
            LegacyResult r = legacyVerify(input.orderId(), input.amountPaisa(), uid, trusted.get("BC"));
            String rAmt = trusted.get("R_AMT"); // amount requested by merchant (DV-signed)
            Map<String, Object> raw = new LinkedHashMap<>();
            raw.put("callback", trusted);
            raw.put("verification", r.text());
            return new VerifyResult(ProviderId.FONEPAY, r.ok() ? PaymentStatus.PAID : PaymentStatus.FAILED, input.orderId(),
                    Js.truthy(rAmt) ? Money.rupeesToPaisa(rAmt) : null, uid, raw);
        }

        throw new PaymentException(
                "Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured for txnVerification",
                ProviderId.FONEPAY, "verify_unavailable");
    }

    private Map<String, Object> txnVerification(String prn, long amountPaisa) {
        // Body is signed byte-for-byte; build it once and send exactly that string (format follows the spec example).
        String body = "{\"prn\": " + Json.quote(prn) + ",\"merchantCode\": " + Json.quote(cfg.merchantCode())
                + ",\"amount\": " + Json.quote(Money.paisaToRupees(amountPaisa)) + "}";
        String auth = Codec.toHex(Crypto.hmac(Crypto.Hash.SHA_512, cfg.secretKey(),
                String.join(",", cfg.username(), cfg.password(), "POST", "application/json", TXN_RESOURCE, body)));
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", Codec.basicAuth(cfg.username(), cfg.password()));
        headers.put("auth", auth);
        headers.put("Content-Type", "application/json");
        Http.Response res = http.request(ProviderId.FONEPAY, txnVerificationUrl,
                new Http.Options("POST", headers, body, cfg.timeout(), 2));
        if (res.status() != 200 || !(Js.get(res.data(), "paymentStatus") instanceof String)) {
            throw new PaymentException("Fonepay txnVerification failed: " + Js.slice(res.text(), 200), ProviderId.FONEPAY, "http_" + res.status(), res.status(), res.data());
        }
        return Esewa.asMap((Map<?, ?>) res.data());
    }

    private record LegacyResult(boolean ok, String text) {}

    /** Legacy (2019) GET verification; needs UID + BC from the redirect. XML is read with the TS regex approach (no XML parser). */
    private LegacyResult legacyVerify(String prn, long amountPaisa, String uid, String bankCode) {
        String amt = Money.paisaToRupees(amountPaisa);
        String dv = hmac(cfg.secretKey(), List.of(cfg.merchantCode(), amt, prn, bankCode, uid));
        Map<String, String> qs = new LinkedHashMap<>();
        qs.put("PRN", prn);
        qs.put("PID", cfg.merchantCode());
        qs.put("BID", bankCode);
        qs.put("AMT", amt);
        qs.put("UID", uid);
        qs.put("DV", dv);
        Http.Response res = http.request(ProviderId.FONEPAY, legacyVerifyUrl + "?" + Codec.formEncode(qs),
                new Http.Options("GET", Map.of("Accept", "application/xml"), null, cfg.timeout(), 2));
        // A 5xx / WAF page / HTML must never read as "not paid": throw so the attempt stays open.
        if (res.status() != 200) {
            throw new PaymentException("Fonepay verification HTTP " + res.status(), ProviderId.FONEPAY, "upstream_error", res.status(), Js.slice(res.text(), 500));
        }
        String code = tag(res.text(), "response_code");
        if (code == null) {
            throw new PaymentException("Fonepay verification: unparseable response", ProviderId.FONEPAY, "malformed_response", res.status(), Js.slice(res.text(), 500));
        }
        return new LegacyResult("successful".equals(code) && "true".equals(tag(res.text(), "success")), res.text());
    }

    private static String tag(String text, String t) {
        Matcher m = Pattern.compile("<" + t + ">([^<]*)</" + t + ">").matcher(text);
        return m.find() ? m.group(1) : null;
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String prn = params.get("PRN");
        return Js.truthy(prn) ? Optional.of(prn) : Optional.empty();
    }

    // ------------------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

    public QrCreated qrCreate(String orderId, long amountPaisa, String remarks1) {
        return qrCreate(orderId, amountPaisa, remarks1, null);
    }

    /** Create a dynamic QR. A websocket URL with a localhost host is rewritten to Fonepay's real socket host. */
    public QrCreated qrCreate(String orderId, long amountPaisa, String remarks1, String remarks2) {
        requireLogin();
        Money.assertPaisa(amountPaisa, ProviderId.FONEPAY);
        String amount = Money.paisaToRupees(amountPaisa);
        String r2 = remarks2 != null ? remarks2 : "N/A";
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("amount", amount);
        body.put("remarks1", remarks1);
        body.put("remarks2", r2);
        body.put("prn", orderId);
        body.put("merchantCode", cfg.merchantCode());
        body.put("dataValidation", hmac(cfg.secretKey(), List.of(amount, orderId, cfg.merchantCode(), remarks1, r2)).toLowerCase(Locale.ROOT));
        body.put("username", cfg.username());
        body.put("password", cfg.password());
        Http.Response res = http.request(ProviderId.FONEPAY, qrBaseUrl + "/thirdPartyDynamicQrDownload", Http.Options.post(body).withTimeout(cfg.timeout()));
        Object qr = Js.get(res.data(), "qrMessage");
        if (!Js.truthy(qr)) {
            Object msg = Js.get(res.data(), "message");
            throw new PaymentException("Fonepay QR create failed: " + (msg != null ? Js.string(msg) : Js.slice(res.text(), 200)),
                    ProviderId.FONEPAY, "http_" + res.status(), res.status(), res.data());
        }
        Object wsRaw = Js.get(res.data(), "thirdpartyQrWebSocketUrl");
        String ws = wsRaw == null ? null : Js.string(wsRaw);
        // Fonepay has been seen returning a localhost host here; rewrite to the real socket host.
        if (ws != null && ws.contains("localhost")) {
            ws = ws.replaceFirst("^wss?://[^/]+", Matcher.quoteReplacement(cfg.env() == Environment.PRODUCTION ? "wss://ws.fonepay.com" : "wss://dev-ws.fonepay.com"));
        }
        return new QrCreated(Js.string(qr), ws, res.data());
    }

    public VerifyResult qrStatus(String orderId) {
        return qrStatus(orderId, null);
    }

    /**
     * Poll QR payment status. Always call this after a websocket "paymentSuccess" message before fulfilling. Pass the
     * stored amount: the status response has none, but the QR was created server-side with it.
     */
    public VerifyResult qrStatus(String orderId, Long amountPaisa) {
        requireLogin();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("prn", orderId);
        body.put("merchantCode", cfg.merchantCode());
        body.put("dataValidation", hmac(cfg.secretKey(), List.of(orderId, cfg.merchantCode())).toLowerCase(Locale.ROOT));
        body.put("username", cfg.username());
        body.put("password", cfg.password());
        Http.Response res = http.request(ProviderId.FONEPAY, qrBaseUrl + "/thirdPartyDynamicQrGetStatus",
                Http.Options.post(body).withTimeout(cfg.timeout()).withRetries(2));
        if (!(Js.get(res.data(), "paymentStatus") instanceof String ps)) {
            throw new PaymentException("Fonepay QR status failed: " + Js.slice(res.text(), 200), ProviderId.FONEPAY, "http_" + res.status(), res.status(), res.data());
        }
        Object trace = Js.get(res.data(), "fonepayTraceId");
        return new VerifyResult(ProviderId.FONEPAY, TXN_STATUS.getOrDefault(ps.toLowerCase(Locale.ROOT), PaymentStatus.UNKNOWN),
                orderId, amountPaisa, trace != null ? Js.id(trace) : null, res.data());
    }

    private void requireLogin() {
        if (!loggedIn()) throw new IllegalStateException("fonepay: username/password required for Dynamic QR");
    }
}
