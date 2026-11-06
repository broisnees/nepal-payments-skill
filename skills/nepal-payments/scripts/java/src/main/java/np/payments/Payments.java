package np.payments;

import java.security.SecureRandom;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * One entry point over the configured providers.
 * <pre>{@code
 * Payments payments = Payments.create(Payments.configFromEnv());
 * InitiateResult r = payments.khalti().initiate(InitiateInput.of(orderId, amountPaisa, description, returnUrl));
 * VerifyResult v = payments.adapter("khalti").verify(VerifyInput.of(orderId, amountPaisa).withProviderRef(pidx));
 * }</pre>
 */
public final class Payments {
    private static final String ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Map<ProviderId, PaymentAdapter> built;

    private Payments(Map<ProviderId, PaymentAdapter> built) {
        this.built = built;
    }

    /** Adapters on the shared {@link JdkHttpTransport}. */
    public static Payments create(PaymentsConfig cfg) {
        return create(cfg, JdkHttpTransport.shared());
    }

    public static Payments create(PaymentsConfig cfg, HttpTransport transport) {
        Map<ProviderId, PaymentAdapter> b = new EnumMap<>(ProviderId.class);
        if (cfg.esewa() != null) b.put(ProviderId.ESEWA, new Esewa(cfg.esewa(), transport));
        if (cfg.khalti() != null) b.put(ProviderId.KHALTI, new Khalti(cfg.khalti(), transport));
        if (cfg.fonepay() != null) b.put(ProviderId.FONEPAY, new Fonepay(cfg.fonepay(), transport));
        if (cfg.connectips() != null) b.put(ProviderId.CONNECTIPS, new ConnectIps(cfg.connectips(), transport));
        if (cfg.cybersource() != null) b.put(ProviderId.CYBERSOURCE, new CyberSource(cfg.cybersource()));
        if (cfg.nps() != null) b.put(ProviderId.NPS, new Nps(cfg.nps(), transport));
        if (cfg.imepay() != null) b.put(ProviderId.IMEPAY, new ImePay(cfg.imepay(), transport));
        if (cfg.nepalpay() != null) b.put(ProviderId.NEPALPAY, new NepalPay(cfg.nepalpay(), transport));
        if (cfg.hamropay() != null) b.put(ProviderId.HAMROPAY, new HamroPay(cfg.hamropay(), transport));
        if (cfg.getpay() != null) b.put(ProviderId.GETPAY, new GetPay(cfg.getpay(), transport));
        return new Payments(b);
    }

    public Esewa esewa() {
        return typed(ProviderId.ESEWA, Esewa.class);
    }

    public Khalti khalti() {
        return typed(ProviderId.KHALTI, Khalti.class);
    }

    public Fonepay fonepay() {
        return typed(ProviderId.FONEPAY, Fonepay.class);
    }

    public ConnectIps connectips() {
        return typed(ProviderId.CONNECTIPS, ConnectIps.class);
    }

    public CyberSource cybersource() {
        return typed(ProviderId.CYBERSOURCE, CyberSource.class);
    }

    public Nps nps() {
        return typed(ProviderId.NPS, Nps.class);
    }

    public ImePay imepay() {
        return typed(ProviderId.IMEPAY, ImePay.class);
    }

    public NepalPay nepalpay() {
        return typed(ProviderId.NEPALPAY, NepalPay.class);
    }

    public HamroPay hamropay() {
        return typed(ProviderId.HAMROPAY, HamroPay.class);
    }

    public GetPay getpay() {
        return typed(ProviderId.GETPAY, GetPay.class);
    }

    /** Untyped access for generic handlers keyed by a route param ("esewa", "khalti", ...). */
    public PaymentAdapter adapter(String id) {
        for (ProviderId p : ProviderId.values()) {
            if (p.wire().equals(id)) return adapter(p);
        }
        throw new IllegalStateException("payment provider \"" + id + "\" is not configured");
    }

    public PaymentAdapter adapter(ProviderId id) {
        PaymentAdapter a = built.get(id);
        if (a == null) throw new IllegalStateException("payment provider \"" + id + "\" is not configured");
        return a;
    }

    /** Configured providers, in declaration order. */
    public List<ProviderId> enabled() {
        return List.copyOf(built.keySet());
    }

    private <A extends PaymentAdapter> A typed(ProviderId id, Class<A> type) {
        return type.cast(adapter(id));
    }

    /** {@link #configFromEnv(Map)} over {@link System#getenv()}. */
    public static PaymentsConfig configFromEnv() {
        return configFromEnv(System.getenv());
    }

    /**
     * Config from environment variables (same names as the TS/Python ports; see references/env.md). A provider is
     * enabled when its required vars are present and non-empty. *_ENV = "production" or "live" means production.
     */
    public static PaymentsConfig configFromEnv(Map<String, String> env) {
        PaymentsConfig cfg = PaymentsConfig.empty();
        if (set(env, "ESEWA_PRODUCT_CODE") && set(env, "ESEWA_SECRET_KEY")) {
            Esewa.Config c = Esewa.Config.of(Environment.parse(env.get("ESEWA_ENV")), env.get("ESEWA_PRODUCT_CODE"), env.get("ESEWA_SECRET_KEY"));
            if (set(env, "ESEWA_INTENT_PRODUCT_CODE") && set(env, "ESEWA_INTENT_ACCESS_KEY")) {
                c = c.withIntent(new Esewa.Intent(env.get("ESEWA_INTENT_PRODUCT_CODE"), env.get("ESEWA_INTENT_ACCESS_KEY"), env.get("ESEWA_INTENT_BASE_URL")));
            }
            cfg = cfg.withEsewa(c);
        }
        if (set(env, "KHALTI_SECRET_KEY") && set(env, "KHALTI_WEBSITE_URL")) {
            cfg = cfg.withKhalti(Khalti.Config.of(Environment.parse(env.get("KHALTI_ENV")), env.get("KHALTI_SECRET_KEY"), env.get("KHALTI_WEBSITE_URL")));
        }
        if (set(env, "FONEPAY_MERCHANT_CODE") && set(env, "FONEPAY_SECRET_KEY")) {
            cfg = cfg.withFonepay(Fonepay.Config.of(Environment.parse(env.get("FONEPAY_ENV")), env.get("FONEPAY_MERCHANT_CODE"), env.get("FONEPAY_SECRET_KEY"))
                    .withLogin(env.get("FONEPAY_USERNAME"), env.get("FONEPAY_PASSWORD")));
        }
        if (set(env, "CONNECTIPS_MERCHANT_ID") && set(env, "CONNECTIPS_APP_ID") && set(env, "CONNECTIPS_PRIVATE_KEY_PEM")) {
            cfg = cfg.withConnectIps(ConnectIps.Config.withPem(Environment.parse(env.get("CONNECTIPS_ENV")), env.get("CONNECTIPS_MERCHANT_ID"),
                    env.get("CONNECTIPS_APP_ID"), env.getOrDefault("CONNECTIPS_APP_NAME", ""), env.getOrDefault("CONNECTIPS_APP_PASSWORD", ""),
                    env.get("CONNECTIPS_PRIVATE_KEY_PEM").replace("\\n", "\n")));
        }
        if (set(env, "CYBERSOURCE_PROFILE_ID") && set(env, "CYBERSOURCE_ACCESS_KEY") && set(env, "CYBERSOURCE_SECRET_KEY")) {
            cfg = cfg.withCyberSource(CyberSource.Config.of(Environment.parse(env.get("CYBERSOURCE_ENV")), env.get("CYBERSOURCE_PROFILE_ID"),
                    env.get("CYBERSOURCE_ACCESS_KEY"), env.get("CYBERSOURCE_SECRET_KEY")).withCurrency(env.getOrDefault("CYBERSOURCE_CURRENCY", "NPR")));
        }
        if (set(env, "NPS_MERCHANT_ID") && set(env, "NPS_SECRET_KEY")) {
            cfg = cfg.withNps(Nps.Config.of(Environment.parse(env.get("NPS_ENV")), env.get("NPS_MERCHANT_ID"), env.getOrDefault("NPS_MERCHANT_NAME", ""),
                    env.getOrDefault("NPS_API_USERNAME", ""), env.getOrDefault("NPS_API_PASSWORD", ""), env.get("NPS_SECRET_KEY")));
        }
        if (set(env, "IMEPAY_MERCHANT_CODE") && set(env, "IMEPAY_USERNAME")) {
            cfg = cfg.withImePay(ImePay.Config.of(Environment.parse(env.get("IMEPAY_ENV")), env.get("IMEPAY_MERCHANT_CODE"), env.get("IMEPAY_USERNAME"),
                    env.getOrDefault("IMEPAY_PASSWORD", ""), env.getOrDefault("IMEPAY_MODULE", "")));
        }
        if (set(env, "NEPALPAY_ACQUIRER_ID") && set(env, "NEPALPAY_MERCHANT_ID") && set(env, "NEPALPAY_USERNAME") && set(env, "NEPALPAY_PRIVATE_KEY_PEM")) {
            NepalPay.Config c = NepalPay.Config.withPem(Environment.parse(env.get("NEPALPAY_ENV")), env.get("NEPALPAY_ACQUIRER_ID"),
                    env.get("NEPALPAY_MERCHANT_ID"), env.getOrDefault("NEPALPAY_MERCHANT_NAME", ""), env.getOrDefault("NEPALPAY_MCC", ""),
                    env.getOrDefault("NEPALPAY_MERCHANT_CITY", "Kathmandu"), env.getOrDefault("NEPALPAY_MERCHANT_POSTAL_CODE", "44600"),
                    env.getOrDefault("NEPALPAY_STORE_LABEL", "Store1"), env.get("NEPALPAY_USERNAME"), env.getOrDefault("NEPALPAY_PASSWORD", ""),
                    env.get("NEPALPAY_PRIVATE_KEY_PEM").replace("\\n", "\n")).withTerminalLabel(env.get("NEPALPAY_TERMINAL_LABEL"));
            if (set(env, "NEPALPAY_CLIENT_ID")) c = c.withOAuth(env.get("NEPALPAY_CLIENT_ID"), env.getOrDefault("NEPALPAY_CLIENT_SECRET", ""));
            if (set(env, "NEPALPAY_NCHL_PUBLIC_KEY_PEM")) c = c.withNchlPublicKeyPem(env.get("NEPALPAY_NCHL_PUBLIC_KEY_PEM").replace("\\n", "\n"));
            if (set(env, "NEPALPAY_WS_URL")) c = c.withWebSocket(env.get("NEPALPAY_WS_URL"), env.get("NEPALPAY_WS_USERNAME"), env.get("NEPALPAY_WS_API_TOKEN"));
            cfg = cfg.withNepalPay(c);
        }
        if (set(env, "HAMROPAY_MERCHANT_ID") && set(env, "HAMROPAY_CLIENT_ID") && set(env, "HAMROPAY_CLIENT_API_KEY") && set(env, "HAMROPAY_CLIENT_SECRET")) {
            cfg = cfg.withHamroPay(HamroPay.Config.of(Environment.parse(env.get("HAMROPAY_ENV")), env.get("HAMROPAY_MERCHANT_ID"), env.get("HAMROPAY_CLIENT_ID"),
                            env.get("HAMROPAY_CLIENT_API_KEY"), env.get("HAMROPAY_CLIENT_SECRET"))
                    .withWebhookSecret(env.get("HAMROPAY_WEBHOOK_SECRET")).withApiBaseUrl(env.get("HAMROPAY_API_BASE_URL"))
                    .withGatewayUrl(env.get("HAMROPAY_GATEWAY_URL")));
        }
        if (set(env, "GETPAY_PAP_INFO") && set(env, "GETPAY_OPR_KEY") && set(env, "GETPAY_WEBSITE_DOMAIN")) {
            cfg = cfg.withGetPay(GetPay.Config.of(Environment.parse(env.get("GETPAY_ENV")), env.get("GETPAY_PAP_INFO"), env.get("GETPAY_OPR_KEY"),
                            env.get("GETPAY_WEBSITE_DOMAIN"), env.getOrDefault("GETPAY_BUSINESS_NAME", ""), env.getOrDefault("GETPAY_IMAGE_URL", ""))
                    .withInsKey(env.get("GETPAY_INS_KEY")).withCurrency(env.get("GETPAY_CURRENCY"))
                    .withBundleUrl(env.get("GETPAY_BUNDLE_URL")).withBaseUrl(env.get("GETPAY_BASE_URL")));
        }
        return cfg;
    }

    private static boolean set(Map<String, String> env, String key) {
        String v = env.get(key);
        return v != null && !v.isEmpty();
    }

    /** {@link #newOrderId(String)} with prefix "P". */
    public static String newOrderId() {
        return newOrderId("P");
    }

    /**
     * Short, provider-safe attempt id: <= 20 chars [A-Z0-9] (fits connectIPS TXNID 20, Fonepay PRN 25, eSewa uuid
     * charset, Khalti/NPS/IME/CyberSource limits). Example: "P1KX3M9Q2ZAB7C4D8E".
     */
    public static String newOrderId(String prefix) {
        StringBuilder sb = new StringBuilder(prefix).append(Long.toString(System.currentTimeMillis(), 36).toUpperCase(Locale.ROOT));
        for (int i = 0; i < 10; i++) sb.append(ALPHABET.charAt(RANDOM.nextInt(36)));
        return sb.length() <= 20 ? sb.toString() : sb.substring(0, 20);
    }
}
