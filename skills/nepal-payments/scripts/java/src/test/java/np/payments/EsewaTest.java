package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "esewa" describe block of adapters.test.ts, plus Python-only and behaviour cases. */
class EsewaTest {
    private final MockTransport http = new MockTransport();
    private final Esewa e = new Esewa(Esewa.Config.sandbox(), http);
    private static final List<String> ORDER = List.of("total_amount", "transaction_uuid", "product_code");

    @Test
    @DisplayName("signature test vectors (docs' own examples are wrong; these are verified)")
    void vectors() {
        String k = Esewa.SANDBOX_SECRET_KEY;
        assertEquals("5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=",
                Esewa.sign(k, Map.of("total_amount", "100", "transaction_uuid", "11-201-13", "product_code", "EPAYTEST"), ORDER));
        assertEquals("0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=",
                Esewa.sign(k, Map.of("total_amount", "110", "transaction_uuid", "ab14a8f2b02c3", "product_code", "EPAYTEST"), ORDER));
        assertEquals("oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=",
                Esewa.sign(Esewa.SANDBOX_INTENT_ACCESS_KEY, Map.of("product_code", "INTENT", "amount", "100", "transaction_uuid", "txn-20251220-001"),
                        List.of("product_code", "amount", "transaction_uuid")));
    }

    @Test
    @DisplayName("initiate: amountPaisa is the total; breakdown included; same string signed and posted")
    void initiate() {
        InitiateResult r = e.initiate(InitiateInput.of("ORD-1", 11050, "x", "https://s/r/ORD-1"), new Esewa.Extras(1000, 0, 0));
        assertEquals("form", r.kind());
        InitiateResult.Form f = assertInstanceOf(InitiateResult.Form.class, r);
        assertEquals("110.50", f.fields().get("total_amount"));
        assertEquals("100.50", f.fields().get("amount"));
        PaymentException ex = assertThrows(PaymentException.class,
                () -> e.initiate(InitiateInput.of("ORD-1", 1000, "x", "https://s"), new Esewa.Extras(1000, 0, 0)));
        assertTrue(ex.getMessage().contains("less than the total"));
        assertEquals(Esewa.sign(Esewa.SANDBOX_SECRET_KEY, f.fields(), ORDER), f.fields().get("signature"));
        assertEquals("https://rc-epay.esewa.com.np/api/epay/main/v2/form", f.action());
    }

    @Test
    @DisplayName("rejects uuid with forbidden characters")
    void uuidCharset() {
        PaymentException ex = assertThrows(PaymentException.class, () -> e.initiate(InitiateInput.of("a_b", 100, "x", "https://s")));
        assertTrue(ex.getMessage().contains("letters, digits"));
    }

    private static Map<String, String> successData(Map<String, String> overrides) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("transaction_code", "000AWEO");
        p.put("status", "COMPLETE");
        p.put("total_amount", "1000.0");
        p.put("transaction_uuid", "ORD-2");
        p.put("product_code", "EPAYTEST");
        p.put("signed_field_names", "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names");
        p.putAll(overrides);
        p.put("signature", Esewa.sign(Esewa.SANDBOX_SECRET_KEY, p, List.of(p.get("signed_field_names").split(","))));
        return p;
    }

    private static String b64(String json) {
        return Codec.toBase64(Codec.utf8(json));
    }

    private static Map<String, String> with(Map<String, String> p, String k, String v) {
        Map<String, String> m = new LinkedHashMap<>(p);
        m.put(k, v);
        return m;
    }

    @Test
    @DisplayName("success payload signature verifies; tamper fails; comma variant accepted")
    void successPayload() {
        Map<String, String> p = successData(Map.of());
        String data = b64(Json.write(p));
        assertTrue(e.parseSuccess(data).signatureValid());
        assertTrue(e.parseSuccess(data.replace('+', ' ')).signatureValid()); // '+' -> ' ' in query
        assertFalse(e.parseSuccess(b64(Json.write(with(p, "total_amount", "1.0")))).signatureValid());
        // eSewa signs "1000.0" but displays "1,000.0"
        assertTrue(e.parseSuccess(b64(Json.write(with(p, "total_amount", "1,000.0")))).signatureValid());
    }

    @Test
    @DisplayName("numeric total_amount is verified against its raw JSON text (1000.0 stays 1000.0)")
    void numericRawText() {
        Map<String, String> p = successData(Map.of()); // signed over total_amount=1000.0
        String json = Json.write(p).replace("\"total_amount\":\"1000.0\"", "\"total_amount\":1000.0");
        assertTrue(json.contains("\"total_amount\":1000.0"));
        assertTrue(e.parseSuccess(b64(json)).signatureValid());
    }

    @Test
    @DisplayName("verify: status API is authoritative and uses the stored total")
    void verifyStatusApi() {
        http.respond(q("{'product_code':'EPAYTEST','transaction_uuid':'ORD-2','total_amount':1000,'status':'COMPLETE','ref_id':'0001TS9'}"));
        VerifyResult v = e.verify(VerifyInput.of("ORD-2", 100000).withCallback(Map.of("data", b64(Json.write(successData(Map.of()))))));
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals(100000L, v.amountPaisa());
        assertEquals("0001TS9", v.transactionId());
        assertEquals("https://rc.esewa.com.np/api/epay/transaction/status/?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2", http.call(0).url());
    }

    @Test
    @DisplayName("verify: callback for another order is rejected")
    void verifyMismatch() {
        Map<String, String> p = successData(Map.of("transaction_uuid", "OTHER"));
        PaymentException ex = assertThrows(PaymentException.class,
                () -> e.verify(VerifyInput.of("ORD-2", 100000).withCallback(Map.of("data", b64(Json.write(p))))));
        assertTrue(ex.getMessage().contains("does not match"));
        assertEquals("callback_mismatch", ex.code());
    }

    @Test
    @DisplayName("status mapping")
    void statusMapping() {
        String[][] cases = {{"PENDING", "pending"}, {"AMBIGUOUS", "pending"}, {"NOT_FOUND", "not_found"}, {"FULL_REFUND", "refunded"},
                {"CANCELED", "canceled"}, {"WEIRD", "unknown"}};
        for (String[] c : cases) {
            http.respond(q("{'status':'" + c[0] + "','total_amount':10,'ref_id':null}"));
            assertEquals(c[1], e.verify(VerifyInput.of("X", 1000)).status().wire());
        }
    }

    // ---------------------------------------------------------------- Python-only cases

    @Test
    @DisplayName("(python) raw value regex tolerates spaced JSON (\"total_amount\": 1000.0)")
    void pythonSpacedJson() {
        Map<String, String> p = successData(Map.of());
        String json = Json.write(p).replace("\":", "\": ").replace(",\"", ", \"").replace("\"total_amount\": \"1000.0\"", "\"total_amount\": 1000.0");
        assertTrue(json.contains("\"total_amount\": 1000.0"));
        assertTrue(e.parseSuccess(b64(json)).signatureValid());
    }

    @Test
    @DisplayName("(python) intentBook signs the amount and sends it as a JSON number")
    void pythonIntentBook() {
        http.respond(q("{'code':'IP-201','data':{'booking_id':'VkQ=','deeplink':'https://rc-links.esewa.com.np/pay/VkQ=','correlation_id':'C1'}}"));
        Esewa.IntentBooking b = e.intentBook("txn-20251220-001", 10000, "https://cb", "https://done");
        Map<String, Object> body = bodyJson(http.call(0));
        assertEquals("oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=", body.get("signature"));
        assertEquals(new BigDecimal("100"), body.get("amount"));
        assertTrue(http.call(0).body().contains("\"amount\":100,"));
        assertEquals("VkQ=|C1", b.providerRef());
        assertEquals("https://rc-checkout.esewa.com.np/api/client/intent/payment/book", http.call(0).url());
        assertEquals(Map.of("remarks", "txn-20251220-001"), body.get("properties"));
    }

    // ---------------------------------------------------------------- behaviours from the brief

    @Test
    @DisplayName("strict mode: bad callback signature throws; lax mode still asks the status API")
    void strictSignature() {
        Map<String, String> p = with(successData(Map.of()), "status", "FAILED"); // tampered after signing
        VerifyInput in = VerifyInput.of("ORD-2", 100000).withCallback(Map.of("data", b64(Json.write(p))));
        PaymentException ex = assertThrows(PaymentException.class, () -> e.verify(in));
        assertEquals("invalid_signature", ex.code());
        assertEquals(400, ex.httpStatus());
        assertTrue(http.calls.isEmpty());

        MockTransport t = new MockTransport().respond(q("{'status':'PENDING','total_amount':1000.0,'ref_id':null}"));
        Esewa lax = new Esewa(Esewa.Config.sandbox().withStrictSignature(false), t);
        VerifyResult v = lax.verify(in);
        assertEquals(PaymentStatus.PENDING, v.status());
        assertEquals(false, Js.get(v.raw(), "signatureValid"));
        assertNull(v.transactionId());
    }

    @Test
    @DisplayName("garbage data param -> malformed_callback, never a status")
    void malformedCallback() {
        PaymentException ex = assertThrows(PaymentException.class, () -> e.verify(VerifyInput.of("ORD-2", 1).withCallback(Map.of("data", "!!!"))));
        assertEquals("malformed_callback", ex.code());
        ex = assertThrows(PaymentException.class, () -> e.parseSuccess(b64("{\"a\":1}")));
        assertEquals("malformed_callback", ex.code());
    }

    @Test
    @DisplayName("orderIdFromCallback: data uuid, then orderId, order_id, transaction_uuid")
    void orderIdFromCallback() {
        assertEquals(Optional.of("ORD-2"), e.orderIdFromCallback(Map.of("data", b64(Json.write(successData(Map.of()))))));
        assertEquals(Optional.empty(), e.orderIdFromCallback(Map.of("data", "not base64 json", "orderId", "X")));
        Map<String, String> both = new LinkedHashMap<>();
        both.put("transaction_uuid", "C");
        both.put("order_id", "B");
        both.put("orderId", "A");
        assertEquals(Optional.of("A"), e.orderIdFromCallback(both));
        both.remove("orderId");
        assertEquals(Optional.of("B"), e.orderIdFromCallback(both));
        assertEquals(Optional.empty(), e.orderIdFromCallback(Map.of()));
    }

    @Test
    @DisplayName("intent: status signs booking|correlation, checks transaction_id; cancel; callback signature")
    void intentFlow() {
        http.respond(q("{'code':'IP-200','data':{'status':'BOOKED','transaction_id':'I1','reference_code':null}}"));
        VerifyResult v = e.intentVerify("I1", "VkQ=|C1", 10000L);
        assertEquals(PaymentStatus.PENDING, v.status());
        assertEquals(10000L, v.amountPaisa());
        Map<String, Object> body = bodyJson(http.call(0));
        assertEquals("C1", body.get("correlation_id"));
        assertEquals(Esewa.sign(Esewa.SANDBOX_INTENT_ACCESS_KEY, Map.of("booking_id", "VkQ=", "product_code", "INTENT", "correlation_id", "C1"),
                List.of("booking_id", "product_code", "correlation_id")), body.get("signature"));

        http.respond(q("{'data':{'status':'SUCCESS','transaction_id':'OTHER'}}"));
        assertEquals("callback_mismatch", assertThrows(PaymentException.class, () -> e.intentVerify("I1", "VkQ=|C1")).code());

        http.respond(q("{'code':'IP-210','data':{'status':'CANCELED'}}"));
        Object c = e.intentCancel("VkQ=|C1");
        assertEquals("CANCELED", Js.get(Js.get(c, "data"), "status"));
        assertEquals("VkQ=", bodyJson(http.call(0)).get("booking_id"));

        Map<String, Object> cb = new LinkedHashMap<>();
        cb.put("product_code", "INTENT");
        cb.put("amount", new BigDecimal("100.0")); // JSON number: signed as String(100.0) = "100"
        cb.put("status", "SUCCESS");
        cb.put("signed_field_names", "product_code,amount,status");
        cb.put("signature", Esewa.sign(Esewa.SANDBOX_INTENT_ACCESS_KEY, Map.of("product_code", "INTENT", "amount", "100", "status", "SUCCESS"),
                List.of("product_code", "amount", "status")));
        assertTrue(e.intentCallbackValid(cb));
        assertTrue(e.intentCallbackValid(Json.write(cb)));
        cb.put("status", "FAILED");
        assertFalse(e.intentCallbackValid(cb));
        assertThrows(IllegalStateException.class, () -> new Esewa(Esewa.Config.of(Environment.PRODUCTION, "P", "S"), http).intentCancel("x"));
    }
}
