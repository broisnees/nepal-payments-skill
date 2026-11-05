package np.payments;

import java.math.BigDecimal;
import java.nio.file.Path;
import java.security.PrivateKey;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * connectIPS (NCHL) e-payment gateway — https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
 * Onboarding via your bank -> NCHL emails MERCHANTID, APPID, APPNAME, app password and the creditor .pfx.
 *
 * <p>Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to loginpage -> connectIPS
 * redirects to your registered success/failure URL with ?TXNID=... -> validatetxn (Basic auth).
 *
 * <p>Key: load the creditor .pfx directly ({@link Config#withPkcs12}) or a PKCS#8 PEM ({@link Config#withPem}).
 */
public final class ConnectIps implements PaymentAdapter {
    private static final ZoneId KATHMANDU = ZoneId.of("Asia/Kathmandu");
    private static final DateTimeFormatter TXNDATE = DateTimeFormatter.ofPattern("dd-MM-uuuu", Locale.ROOT);
    private static final Pattern TXNID = Pattern.compile("[A-Za-z0-9-]{1,20}");
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);

    /**
     * @param merchantId  MERCHANTID as issued (e.g. "550")
     * @param appId       e.g. "MER-550-APP-1"
     * @param appName     <= 30 chars
     * @param appPassword app password for Basic auth on validatetxn / gettxndetail
     * @param privateKey  creditor private key (parsed once)
     * @param baseUrl     override; null = default for env
     */
    public record Config(Environment env, String merchantId, String appId, String appName, String appPassword,
                         PrivateKey privateKey, String baseUrl, Duration timeout) {
        public Config {
            Objects.requireNonNull(env, "env");
            Objects.requireNonNull(merchantId, "merchantId");
            Objects.requireNonNull(appId, "appId");
            Objects.requireNonNull(appName, "appName");
            Objects.requireNonNull(appPassword, "appPassword");
            Objects.requireNonNull(privateKey, "privateKey");
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
        }

        /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"); PKCS#1 is rejected with the openssl command to convert it. */
        public static Config withPem(Environment env, String merchantId, String appId, String appName, String appPassword, String privateKeyPem) {
            return new Config(env, merchantId, appId, appName, appPassword, Crypto.privateKeyFromPem(privateKeyPem), null, null);
        }

        /** The creditor .pfx as issued by NCHL, no OpenSSL conversion (legacy RC2/3DES files included). */
        public static Config withPkcs12(Environment env, String merchantId, String appId, String appName, String appPassword, Path pfx, char[] pfxPassword) {
            return new Config(env, merchantId, appId, appName, appPassword, Crypto.privateKeyFromPkcs12(pfx, pfxPassword), null, null);
        }

        public Config withBaseUrl(String baseUrl) {
            return new Config(env, merchantId, appId, appName, appPassword, privateKey, baseUrl, timeout);
        }

        public Config withTimeout(Duration timeout) {
            return new Config(env, merchantId, appId, appName, appPassword, privateKey, baseUrl, timeout);
        }
    }

    /** Optional initiate fields (each nullable): REFERENCEID (default orderId), REMARKS, PARTICULARS (default description). */
    public record Extras(String referenceId, String remarks, String particulars) {
        public static final Extras NONE = new Extras(null, null, null);
    }

    private final Config cfg;
    private final Http http;
    private final String base;
    private final Map<String, String> auth;

    public ConnectIps(Config cfg) {
        this(cfg, JdkHttpTransport.shared());
    }

    public ConnectIps(Config cfg, HttpTransport transport) {
        this.cfg = Objects.requireNonNull(cfg, "cfg");
        this.http = new Http(transport);
        this.base = cfg.baseUrl() != null ? cfg.baseUrl() : cfg.env() == Environment.SANDBOX ? "https://uat.connectips.com" : "https://login.connectips.com";
        this.auth = Map.of("Authorization", Codec.basicAuth(cfg.appId(), cfg.appPassword()));
    }

    @Override
    public ProviderId id() {
        return ProviderId.CONNECTIPS;
    }

    /** DD-MM-YYYY in Asia/Kathmandu. */
    public static String date(Instant at) {
        return TXNDATE.format(at.atZone(KATHMANDU));
    }

    public static String date() {
        return date(Instant.now());
    }

    /** The exact string connectIPS expects to be signed for the gateway form. */
    public static String tokenString(Map<String, String> f) {
        return "MERCHANTID=" + f.get("MERCHANTID") + ",APPID=" + f.get("APPID") + ",APPNAME=" + f.get("APPNAME")
                + ",TXNID=" + f.get("TXNID") + ",TXNDATE=" + f.get("TXNDATE") + ",TXNCRNCY=" + f.get("TXNCRNCY")
                + ",TXNAMT=" + f.get("TXNAMT") + ",REFERENCEID=" + f.get("REFERENCEID") + ",REMARKS=" + f.get("REMARKS")
                + ",PARTICULARS=" + f.get("PARTICULARS") + ",TOKEN=TOKEN";
    }

    /** Commas/equals would corrupt the token string. */
    private static String clip(String s, int n) {
        return Js.slice(s.replace(',', ' ').replace('=', ' '), n);
    }

    @Override
    public InitiateResult initiate(InitiateInput input) {
        return initiate(input, Extras.NONE);
    }

    /**
     * Form POST to the connectIPS login page. TXNID = orderId (<= 20 chars, unique per app). Success/failure redirect
     * URLs are REGISTERED WITH NCHL, not sent per request; returnUrl is unused here.
     */
    public InitiateResult initiate(InitiateInput input, Extras extras) {
        Money.assertPaisa(input.amountPaisa(), ProviderId.CONNECTIPS);
        if (!TXNID.matcher(input.orderId()).matches()) {
            throw new PaymentException("connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", ProviderId.CONNECTIPS, "invalid_order_id");
        }
        // Empty extras fall back too (TS ||).
        String remarks = clip(Js.truthy(extras.remarks()) ? extras.remarks() : input.description(), 50);
        String particulars = clip(Js.truthy(extras.particulars()) ? extras.particulars() : input.description(), 100);
        Map<String, String> f = new LinkedHashMap<>();
        f.put("MERCHANTID", cfg.merchantId());
        f.put("APPID", cfg.appId());
        f.put("APPNAME", Js.slice(cfg.appName(), 30));
        f.put("TXNID", input.orderId());
        f.put("TXNDATE", date());
        f.put("TXNCRNCY", "NPR");
        f.put("TXNAMT", Long.toString(input.amountPaisa())); // PAISA
        f.put("REFERENCEID", clip(Js.truthy(extras.referenceId()) ? extras.referenceId() : input.orderId(), 20));
        f.put("REMARKS", remarks.isEmpty() ? "Payment" : remarks);
        f.put("PARTICULARS", particulars.isEmpty() ? "Payment" : particulars);
        f.put("TOKEN", Crypto.rsaSha256SignBase64(cfg.privateKey(), tokenString(f)));
        return new InitiateResult.Form(base + "/connectipswebgw/loginpage", f);
    }

    /** validatetxn — authoritative. SUCCESS + amount match = paid. */
    @Override
    public VerifyResult verify(VerifyInput input) {
        Map<String, Object> r = validationCall("validatetxn", input.orderId(), input.amountPaisa());
        String desc = Js.stringOrEmpty(r.get("statusDesc")).toUpperCase(Locale.ROOT);
        Object st = r.get("status");
        PaymentStatus status;
        if ("SUCCESS".equals(st)) status = PaymentStatus.PAID;
        else if ("FAILED".equals(st)) status = PaymentStatus.FAILED;
        else if (desc.contains("NOT FOUND")) status = PaymentStatus.NOT_FOUND;
        else if (desc.contains("INCOMPLETE")) status = PaymentStatus.PENDING; // user hasn't finished OTP yet
        else status = PaymentStatus.UNKNOWN;
        Long amount = null;
        if (r.get("txnAmt") != null) { // TS: Math.round(Number(txnAmt)), kept only if finite; Number(null) would be 0
            double d = Js.toNumber(r.get("txnAmt"));
            if (Double.isFinite(d)) amount = Math.round(d);
        }
        return new VerifyResult(ProviderId.CONNECTIPS, status, input.orderId(), amount, null, r);
    }

    /** Full detail incl. NCHL txnId, bank, charges and creditStatus ("000"/"999"/"DEFER" = credited/OK). */
    public Map<String, Object> getTxnDetail(String orderId, long amountPaisa) {
        return validationCall("gettxndetail", orderId, amountPaisa);
    }

    private Map<String, Object> validationCall(String path, String txnId, long amountPaisa) {
        String tokenString = "MERCHANTID=" + cfg.merchantId() + ",APPID=" + cfg.appId() + ",REFERENCEID=" + txnId + ",TXNAMT=" + amountPaisa;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchantId", jsNumber(cfg.merchantId()));
        body.put("appId", cfg.appId());
        body.put("referenceId", txnId); // NOTE: the TXNID you sent, not REFERENCEID
        body.put("txnAmt", amountPaisa);
        body.put("token", Crypto.rsaSha256SignBase64(cfg.privateKey(), tokenString));
        Http.Response res = http.request(ProviderId.CONNECTIPS, base + "/connectipswebws/api/creditor/" + path,
                Http.Options.post(body).withHeaders(auth).withTimeout(cfg.timeout()).withRetries(2));
        if (res.status() == 401) throw new PaymentException("connectIPS: 401 — wrong APPID/app password", ProviderId.CONNECTIPS, "unauthorized", 401, null);
        if (res.status() != 200 || !Js.truthy(Js.get(res.data(), "status"))) {
            throw new PaymentException("connectIPS " + path + " failed: " + Js.slice(res.text(), 200), ProviderId.CONNECTIPS, "http_" + res.status(), res.status(), res.data());
        }
        return Esewa.asMap((Map<?, ?>) res.data());
    }

    /** TS Number(merchantId) in a JSON body: 550 for "550"; null (JSON.stringify(NaN)) if not numeric. */
    private static Object jsNumber(String s) {
        double d = Js.toNumber(s);
        if (!Double.isFinite(d)) return null;
        if (d == Math.rint(d) && Math.abs(d) <= Money.MAX_SAFE_INTEGER) return (long) d;
        return new BigDecimal(Js.numberToString(d));
    }

    @Override
    public Optional<String> orderIdFromCallback(Map<String, String> params) {
        String id = params.get("TXNID");
        if (Js.truthy(id)) return Optional.of(id);
        id = params.get("txnId");
        return Js.truthy(id) ? Optional.of(id) : Optional.empty();
    }
}
