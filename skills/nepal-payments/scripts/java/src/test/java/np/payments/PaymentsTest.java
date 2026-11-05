package np.payments;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class PaymentsTest {

    @Test
    @DisplayName("configFromEnv: same variable names as TS; providers enabled only when required vars are set")
    void configFromEnv() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        String pem = "-----BEGIN PRIVATE KEY-----\\n" + Base64.getEncoder().encodeToString(g.generateKeyPair().getPrivate().getEncoded()) + "\\n-----END PRIVATE KEY-----";
        Map<String, String> env = new HashMap<>();
        env.put("ESEWA_PRODUCT_CODE", "EPAYTEST");
        env.put("ESEWA_SECRET_KEY", "k");
        env.put("ESEWA_ENV", "live");
        env.put("ESEWA_INTENT_PRODUCT_CODE", "INTENT");
        env.put("ESEWA_INTENT_ACCESS_KEY", "a");
        env.put("KHALTI_SECRET_KEY", "s"); // no KHALTI_WEBSITE_URL -> disabled
        env.put("FONEPAY_MERCHANT_CODE", "NBQM");
        env.put("FONEPAY_SECRET_KEY", "x");
        env.put("FONEPAY_ENV", "production");
        env.put("CONNECTIPS_MERCHANT_ID", "550");
        env.put("CONNECTIPS_APP_ID", "MER-550-APP-1");
        env.put("CONNECTIPS_PRIVATE_KEY_PEM", pem); // "\n" escapes allowed
        env.put("CYBERSOURCE_PROFILE_ID", "p");
        env.put("CYBERSOURCE_ACCESS_KEY", "a");
        env.put("CYBERSOURCE_SECRET_KEY", "s");
        env.put("NPS_MERCHANT_ID", "9");
        env.put("NPS_SECRET_KEY", "");  // empty = not set
        env.put("IMEPAY_MERCHANT_CODE", "MC");
        env.put("IMEPAY_USERNAME", "u");
        PaymentsConfig cfg = Payments.configFromEnv(env);
        assertEquals(Environment.PRODUCTION, cfg.esewa().env());
        assertEquals(new Esewa.Intent("INTENT", "a", null), cfg.esewa().intent());
        assertNull(cfg.khalti());
        assertEquals(Environment.PRODUCTION, cfg.fonepay().env());
        assertNull(cfg.fonepay().username());
        assertEquals(Environment.SANDBOX, cfg.connectips().env());
        assertEquals("", cfg.connectips().appName());
        assertEquals("NPR", cfg.cybersource().currency());
        assertNull(cfg.nps());
        assertEquals("", cfg.imepay().password());

        Payments p = Payments.create(cfg, new MockTransport());
        assertEquals(List.of(ProviderId.ESEWA, ProviderId.FONEPAY, ProviderId.CONNECTIPS, ProviderId.CYBERSOURCE, ProviderId.IMEPAY), p.enabled());
        assertSame(p.esewa(), p.adapter("esewa"));
        assertNotNull(p.connectips());
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> p.adapter("khalti"));
        assertEquals("payment provider \"khalti\" is not configured", e.getMessage());
        assertThrows(IllegalStateException.class, () -> p.adapter("paypal"));
        assertThrows(IllegalStateException.class, p::nps);
    }

    @Test
    @DisplayName("enums carry the TS wire strings")
    void wireStrings() {
        assertEquals("partially_refunded", PaymentStatus.PARTIALLY_REFUNDED.wire());
        assertEquals(PaymentStatus.NOT_FOUND, PaymentStatus.fromWire("not_found"));
        assertEquals(AttemptStatus.INITIATED, AttemptStatus.fromWire("initiated"));
        assertEquals(ProviderId.CONNECTIPS, ProviderId.fromWire("connectips"));
        assertEquals(List.of(AttemptStatus.INITIATED, AttemptStatus.PENDING, AttemptStatus.UNKNOWN), List.copyOf(StateMachine.OPEN_STATUSES));
        assertEquals(Environment.SANDBOX, Environment.parse(null));
    }
}
