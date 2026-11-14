package np.payments;

import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

/** TODO.md correctness list; mirrors the regression tests in scripts/ts/test/ (spread across core/ and providers/). */
class RegressionsTest {
    private final MockTransport http = new MockTransport();
    private final Esewa e = new Esewa(Esewa.Config.sandbox(), http);

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static String b64(String s) {
        return b64(s.getBytes(StandardCharsets.UTF_8));
    }

    private static PaymentException fails(String code, Integer httpStatus, Executable call) {
        PaymentException ex = assertThrows(PaymentException.class, call);
        assertEquals(code, ex.code());
        assertEquals(httpStatus, ex.httpStatus());
        return ex;
    }

    @Test
    @DisplayName("paisaToRupees keeps the sign below one rupee")
    void paisaSign() {
        assertEquals("-0.05", Money.paisaToRupees(-5));
        assertEquals("-0.99", Money.paisaToRupees(-99));
        assertEquals("-1", Money.paisaToRupees(-100));
        assertEquals("-123.45", Money.paisaToRupees(-12345));
    }

    @Test
    @DisplayName("rupeesToPaisa rejects exponent and explicit plus forms")
    void strictRupees() {
        for (String bad : List.of("1e3", "+5", "NaN", "")) {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, () -> Money.rupeesToPaisa(bad));
            assertTrue(ex.getMessage().contains("not a rupee amount"));
        }
    }

    @Test
    @DisplayName("basicAuth encodes UTF-8 credentials")
    void basicAuthUtf8() {
        assertEquals("Basic " + b64("ü:पासवर्ड"), Codec.basicAuth("ü", "पासवर्ड"));
    }

    @Test
    @DisplayName("newOrderId uses only the 36-symbol alphabet")
    void newOrderId() {
        for (int i = 0; i < 200; i++) assertTrue(Payments.newOrderId().matches("^P[0-9A-Z]{18,19}$"));
    }

    @Test
    @DisplayName("provider lookup ignores Object.prototype keys")
    void providerLookup() {
        Payments payments = Payments.create(PaymentsConfig.empty().withEsewa(Esewa.Config.sandbox()), http);
        for (String id : List.of("constructor", "__proto__", "toString")) {
            IllegalStateException ex = assertThrows(IllegalStateException.class, () -> payments.adapter(id));
            assertTrue(ex.getMessage().contains("not configured"));
        }
        assertEquals(ProviderId.ESEWA, payments.adapter("esewa").id());
    }

    @Test
    @DisplayName("status tables ignore Object.prototype keys")
    void statusTables() {
        for (String s : List.of("constructor", "__proto__", "toString")) {
            http.respond(q("{'status':'" + s + "','total_amount':10,'ref_id':null}"));
            assertEquals(PaymentStatus.UNKNOWN, e.verify(VerifyInput.of("X", 1000)).status());
        }
    }

    @Test
    @DisplayName("eSewa: malformed success data is a 400, not a raw parse error")
    void esewaMalformedData() {
        for (String data : List.of("!!!!", b64("not json"), b64("{"), b64(new byte[] {(byte) 0xff, (byte) 0xfe}))) {
            fails("malformed_callback", 400, () -> e.parseSuccess(data));
            fails("malformed_callback", 400, () -> e.verify(VerifyInput.of("X", 1000).withCallback(Map.of("data", data))));
        }
    }

    @Test
    @DisplayName("eSewa: error body read from error_message or errorMessage")
    void esewaErrorBodies() {
        http.respond(503, q("{'code':0,'errorMessage':'Service is currently unavailable'}"));
        PaymentException ex = fails("esewa_0", 503, () -> e.verify(VerifyInput.of("X", 1000)));
        assertTrue(ex.getMessage().contains("Service is currently unavailable"));
        http.respond(400, q("{'code':'IP-400','error_message':'Invalid Signature'}"));
        ex = fails("esewa_IP-400", 400, () -> e.intentBook("X", 10000, "https://c", "https://r"));
        assertTrue(ex.getMessage().contains("Invalid Signature"));
        http.respond(400, q("{'code':'IP-400','errorMessage':'Invalid Signature'}"));
        ex = fails("esewa_IP-400", 400, () -> e.intentVerify("X", "B|C"));
        assertTrue(ex.getMessage().contains("Invalid Signature"));
        http.respond(502, "<html>bad gateway</html>");
        fails("http_502", 502, () -> e.verify(VerifyInput.of("X", 1000)));
    }

    @Test
    @DisplayName("eSewa orderIdFromCallback: orderId before order_id")
    void esewaOrderIdKeyOrder() {
        assertEquals(Optional.of("A"), e.orderIdFromCallback(Map.of("orderId", "A", "order_id", "B")));
    }

    @Test
    @DisplayName("eSewa Intent callback: raw body keeps number text; parsed body uses String(v)")
    void intentCallbackFormats() {
        String key = Esewa.SANDBOX_INTENT_ACCESS_KEY;
        List<String> order = List.of("product_code", "amount", "reference_code", "status");
        String names = String.join(",", order);
        Map<String, Object> base = new LinkedHashMap<>(Map.of("product_code", "INTENT", "reference_code", "R1", "status", "SUCCESS"));
        // Signed over "100.0", exactly as the JSON text carries it.
        base.put("amount", "100.0");
        String sigExact = Esewa.sign(key, base, order);
        String raw = "{\"product_code\":\"INTENT\",\"amount\":100.0,\"reference_code\":\"R1\",\"status\":\"SUCCESS\",\"signed_field_names\":\""
                + names + "\",\"signature\":\"" + sigExact + "\"}";
        assertTrue(e.intentCallbackValid(raw));
        assertFalse(e.intentCallbackValid(Esewa.asMap((Map<?, ?>) Json.parse(raw)))); // parsed: 100.0 signs as "100"
        // Signed over "100", the String(v) form; the raw body is accepted too.
        base.put("amount", "100");
        String raw2 = raw.replace(sigExact, Esewa.sign(key, base, order));
        assertTrue(e.intentCallbackValid(raw2));
        assertTrue(e.intentCallbackValid(Esewa.asMap((Map<?, ?>) Json.parse(raw2))));
        // null signs as "", tamper and junk fail.
        base.put("amount", "");
        Map<String, Object> cb = new LinkedHashMap<>(base);
        cb.put("amount", null);
        cb.put("signed_field_names", names);
        cb.put("signature", Esewa.sign(key, base, order));
        assertTrue(e.intentCallbackValid(cb));
        assertFalse(e.intentCallbackValid(raw.replace("100.0", "1.0")));
        assertFalse(e.intentCallbackValid("not json"));
        assertFalse(e.intentCallbackValid("[1]"));
    }

    @Test
    @DisplayName("NPS: code 0 with null data is unknown, not an error")
    void npsNullData() {
        Nps n = new Nps(Nps.Config.of(Environment.SANDBOX, "9", "M", "u", "p", "s"), http);
        http.respond(q("{'code':'0','message':'','errors':[],'data':null}"));
        VerifyResult v = n.verify(VerifyInput.of("T1", 10000));
        assertEquals(PaymentStatus.UNKNOWN, v.status());
        assertNull(v.amountPaisa());
    }

    @Test
    @DisplayName("connectIPS: txnAmt null is null, empty referenceId/remarks fall back")
    void connectIpsFallbacks() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        String pem = "-----BEGIN PRIVATE KEY-----\n" + b64(g.generateKeyPair().getPrivate().getEncoded()) + "\n-----END PRIVATE KEY-----";
        ConnectIps c = new ConnectIps(ConnectIps.Config.withPem(Environment.SANDBOX, "550", "A", "T", "pw", pem), http);
        http.respond(q("{'status':'ERROR','statusDesc':'TRANSACTION NOT FOUND','txnAmt':null}"));
        assertNull(c.verify(VerifyInput.of("T1", 500)).amountPaisa());
        Map<String, String> f = ((InitiateResult.Form) c.initiate(InitiateInput.of("T1", 500, "Shoes", ""), new ConnectIps.Extras("", "", null))).fields();
        assertEquals("T1", f.get("REFERENCEID"));
        assertEquals("Shoes", f.get("REMARKS"));
    }

    @Test
    @DisplayName("CyberSource: empty req_reference_number falls back to req_transaction_uuid")
    void cyberSourceEmptyReference() {
        CyberSource cs = new CyberSource(CyberSource.Config.of(Environment.SANDBOX, "p", "a", "s"));
        Map<String, String> p = new LinkedHashMap<>();
        p.put("decision", "ACCEPT");
        p.put("reason_code", "100");
        p.put("req_reference_number", "");
        p.put("req_transaction_uuid", "T1");
        p.put("req_amount", "10.00");
        p.put("req_currency", "NPR");
        p.put("transaction_id", "X1");
        List<String> names = new ArrayList<>(p.keySet());
        names.add("signed_field_names");
        p.put("signed_field_names", String.join(",", names));
        p.put("signature", CyberSource.sign("s", p));
        assertEquals(PaymentStatus.PAID, cs.verify(VerifyInput.of("T1", 1000).withCallback(p)).status());
    }
}
