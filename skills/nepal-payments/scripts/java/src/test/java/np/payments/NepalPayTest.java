package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Cipher;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of scripts/ts/test/providers/nepalpay.test.ts. */
class NepalPayTest {
    private static KeyPair kp;
    private static String pem;
    private final MockTransport http = new MockTransport();

    private static final String GENERATED = q("{'timestamp':'2022-05-23 04:25:26','responseCode':'000','responseStatus':'SUCCESS',"
            + "'responseMessage':'QR String generated successfully.',"
            + "'data':{'validationTraceId':'2205260000001900KIY','qrString':' 000201010212...6304607F','qrImage':'iVBORw0KGgo='}}");

    @BeforeAll
    static void keys() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        kp = g.generateKeyPair();
        String b64 = Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded());
        pem = "-----BEGIN PRIVATE KEY-----\n" + String.join("\n", b64.split("(?<=\\G.{64})")) + "\n-----END PRIVATE KEY-----";
    }

    private static NepalPay.Config base() {
        return NepalPay.Config.withPem(Environment.SANDBOX, "00001701", "17012UVSTIR", "BBSM", "5021", "Kathmandu", "4600", "Store1",
                "npiuser", "pw", pem).withTerminalLabel("Terminal1");
    }

    private NepalPay adapter() {
        return new NepalPay(base(), http);
    }

    private static boolean verifySig(String b64Sig, String message) throws Exception {
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initVerify(kp.getPublic());
        s.update(message.getBytes(StandardCharsets.UTF_8));
        return s.verify(Codec.fromBase64(b64Sig));
    }

    private static String basic(String userPass) {
        return "Basic " + Base64.getEncoder().encodeToString(userPass.getBytes(StandardCharsets.UTF_8));
    }

    /** txn({...}): a PMT row for P1; overrides repeat keys and the last one wins, like the TS spread. */
    private static String txn(String overrides) {
        return "{'nQrTxnId':'2312060000059575KMB','amount':10.5,'tranType':'PMT','merchantBillNo':'P1'," + overrides + "}";
    }

    private static String report(String... rows) {
        return q("{'timestamp':'2024-02-07T07:10:47.928+0000','responseCode':'200','responseStatus':'SUCCESS','responseBody':["
                + String.join(",", rows) + "]}");
    }

    @Test
    @DisplayName("token string: comma-joined, no spaces, userId last")
    void tokenString() {
        assertEquals("00001701,17012UVSTIR,5021,524,10.50,P1,npiuser",
                NepalPay.tokenString("00001701", "17012UVSTIR", "5021", "524", "10.50", "P1", "npiuser"));
    }

    @Test
    @DisplayName("initiate: dynamic QR (12), rupees with 2 decimals, signed token, Basic auth, qr result")
    void initiate() throws Exception {
        NepalPay n = adapter();
        http.respond(GENERATED);
        InitiateResult r = n.initiate(InitiateInput.of("P1", 1050, "Everest T-shirt, large and blue", ""));
        assertEquals("https://devopennpi.connectips.com/qr/generateQR", http.call(0).url());
        assertEquals(basic("npiuser:pw"), header(http.call(0), "Authorization"));
        Map<String, Object> body = bodyJson(http.call(0));
        assertEquals(new BigDecimal("12"), body.get("pointOfInitialization"));
        assertEquals("10.50", body.get("transactionAmount"));
        assertEquals(new BigDecimal("524"), body.get("transactionCurrency"));
        assertEquals(new BigDecimal("5021"), body.get("merchantCategoryCode"));
        assertEquals("P1", body.get("billNumber"));
        assertEquals(25, ((String) body.get("purposeOfTransaction")).length());
        assertEquals(true, body.get("qrImage"));
        assertTrue(verifySig((String) body.get("token"), "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"));
        assertEquals("qr", r.kind());
        InitiateResult.Qr qr = assertInstanceOf(InitiateResult.Qr.class, r);
        assertEquals("2205260000001900KIY", qr.providerRef());
        assertEquals("000201010212...6304607F", qr.qrString());
        assertEquals("iVBORw0KGgo=", qr.qrImage());

        http.respond(GENERATED);
        n.initiate(InitiateInput.of("P2", 100000, "x", ""));
        assertEquals("1000.00", bodyJson(http.call(0)).get("transactionAmount"));
    }

    @Test
    @DisplayName("initiate: billNumber charset/length, error codes surface")
    void initiateErrors() {
        NepalPay n = adapter();
        PaymentException e = assertThrows(PaymentException.class, () -> n.initiate(InitiateInput.of("X".repeat(26), 100, "x", "")));
        assertTrue(e.getMessage().contains("1–25"));
        http.respond(400, q("{'responses':[{'responseCode':'E003','responseMessage':'INVALID TOKEN'}]}"));
        e = assertThrows(PaymentException.class, () -> n.initiate(InitiateInput.of("P1", 100, "x", "")));
        assertEquals("E003", e.code());
    }

    @Test
    @DisplayName("verify: report by validationTraceId; a success after a failed scan counts")
    void verifyAfterFailedScan() {
        http.respond(report(txn("'nQrTxnId':'A','debitStatus':'E001','creditStatus':null"), txn("'nQrTxnId':'B','debitStatus':'000','creditStatus':'DEFER'")));
        VerifyResult v = adapter().verify(VerifyInput.of("P1", 1050).withProviderRef("2205260000001900KIY"));
        assertEquals("https://devopennpi.connectips.com/nQR/v1/merchanttxnreport", http.call(0).url());
        assertEquals(Map.of("validationTraceId", "2205260000001900KIY", "merchantId", "17012UVSTIR", "acquirerId", "00001701"), bodyJson(http.call(0)));
        assertEquals(Arrays.asList(PaymentStatus.PAID, 1050L, "B"), Arrays.asList(v.status(), v.amountPaisa(), v.transactionId()));
    }

    @Test
    @DisplayName("verify: status mapping")
    void statusMapping() {
        NepalPay n = adapter();
        List<Map.Entry<String, PaymentStatus>> cases = List.of(
                Map.entry(report(txn("'debitStatus':'000','creditStatus':'000'")), PaymentStatus.PAID),
                Map.entry(report(txn("'debitStatus':'000','creditStatus':'999'")), PaymentStatus.PAID),
                Map.entry(report(txn("'debitStatus':'000','creditStatus':'E99'")), PaymentStatus.UNKNOWN),
                Map.entry(report(txn("'debitStatus':'E001','creditStatus':null")), PaymentStatus.FAILED),
                Map.entry(report(txn("'debitStatus':'000','creditStatus':'000','tranType':'RFND'")), PaymentStatus.NOT_FOUND),
                Map.entry(report(), PaymentStatus.NOT_FOUND),
                Map.entry(q("{'responseCode':'E010','responseMessage':'RECORD NOT FOUND'}"), PaymentStatus.NOT_FOUND));
        for (Map.Entry<String, PaymentStatus> c : cases) {
            http.respond(c.getKey());
            assertEquals(c.getValue(), n.verify(VerifyInput.of("P1", 1050).withProviderRef("T")).status(), c.getKey());
        }
        PaymentException e = assertThrows(PaymentException.class, () -> n.verify(VerifyInput.of("P1", 1050)));
        assertEquals("missing_provider_ref", e.code());
    }

    @Test
    @DisplayName("oauth: password grant once, Bearer reused until expiry")
    void oauth() {
        NepalPay o = new NepalPay(base().withOAuth("cid", "csec"), http);
        http.respondWith(r -> new HttpTransport.Response(200, r.url().endsWith("/oauth/token")
                ? q("{'access_token':'AT1','token_type':'bearer','expires_in':299}") : report()));
        o.verify(VerifyInput.of("P1", 100).withProviderRef("T"));
        o.verify(VerifyInput.of("P1", 100).withProviderRef("T"));
        assertEquals(3, http.calls.size());
        assertEquals(basic("cid:csec"), header(http.call(0), "Authorization"));
        assertEquals("grant_type=password&username=npiuser&password=pw", http.call(0).body());
        assertEquals("Bearer AT1", header(http.call(1), "Authorization"));
        assertEquals("Bearer AT1", header(http.call(2), "Authorization"));
    }

    @Test
    @DisplayName("confirm-payment reply is signed over txnDate,status,message,merchantBillNo,paymentRef")
    void confirmationResponse() throws Exception {
        NepalPay n = adapter();
        Map<String, String> r = n.confirmationResponse("2024-11-10 01:35:31", "P1", "2411100000067378ZHU");
        assertTrue(verifySig(r.get("signature"), "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU"));
        assertEquals(Optional.of("P1"), n.orderIdFromCallback(Map.of("merchantBillNo", "P1")));
    }

    private static String spki() {
        String b64 = Base64.getEncoder().encodeToString(kp.getPublic().getEncoded());
        return "-----BEGIN PUBLIC KEY-----\n" + b64 + "\n-----END PUBLIC KEY-----";
    }

    private NepalPay withNchl() {
        return new NepalPay(base().withNchlPublicKeyPem(spki()).withWebSocket("wss://ws.example/nqrws", "wsuser", "secret-api-token"), http);
    }

    @Test
    @DisplayName("confirm-payment notification: signature over the documented string, payerMobile fallback")
    void confirmationNotification() throws Exception {
        Map<String, Object> note = new LinkedHashMap<>();
        note.put("merchantBillNo", "NA");
        note.put("merchantId", "0010SVQNL9H");
        note.put("merchantName", "Quantum Labs");
        note.put("paymentRef", "2411100000067378ZHU");
        note.put("channel", "CIPS");
        note.put("payerMobile", "+977-9843705813");
        note.put("sessionNo", "5446");
        note.put("status", "SUCCESS");
        String msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446";
        assertEquals(msg, NepalPay.confirmationString(note));
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(kp.getPrivate());
        s.update(msg.getBytes(StandardCharsets.UTF_8));
        String sig = Base64.getEncoder().encodeToString(s.sign());
        NepalPay w = withNchl();
        Map<String, Object> signed = new HashMap<>(note);
        signed.put("signature", sig);
        assertTrue(w.verifyConfirmation(signed));
        Map<String, Object> tampered = new HashMap<>(signed);
        tampered.put("sessionNo", "5447");
        assertFalse(w.verifyConfirmation(tampered));
        Map<String, Object> garbage = new HashMap<>(note);
        garbage.put("signature", "not base64!");
        assertFalse(w.verifyConfirmation(garbage));
        assertFalse(w.verifyConfirmation(note));
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> adapter().verifyConfirmation(note));
        assertTrue(e.getMessage().contains("nchlPublicKey"));
    }

    @Test
    @DisplayName("WebSocket request: destinations, terminal as merchant_id, api_token RSA PKCS#1 v1.5 encrypted")
    void webSocketRequest() throws Exception {
        NepalPay n = withNchl();
        NepalPay.WebSocketRequest w = n.webSocketRequest("2205260000001900KIY");
        assertEquals("wss://ws.example/nqrws", w.url());
        assertEquals("/user/nqrws/check-txn-status", w.subscribe());
        assertEquals("/nqrws/check-txn-status", w.send());
        assertEquals("Terminal1", w.body().get("merchant_id"));
        assertEquals("2205260000001900KIY", w.body().get("request_id"));
        assertEquals("wsuser", w.body().get("username"));
        byte[] ct = Base64.getDecoder().decode(w.body().get("api_token"));
        assertEquals(256, ct.length);
        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.DECRYPT_MODE, kp.getPrivate());
        assertEquals("secret-api-token", new String(c.doFinal(ct), StandardCharsets.UTF_8));
        assertNotEquals(n.webSocketRequest("X").body().get("api_token"), n.webSocketRequest("X").body().get("api_token"));
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> adapter().webSocketRequest("X"));
        assertTrue(e.getMessage().contains("wsUrl"));
        IllegalArgumentException tooLong = assertThrows(IllegalArgumentException.class, () -> Crypto.rsaPkcs1EncryptBase64(spki(), "x".repeat(246)));
        assertTrue(tooLong.getMessage().contains("too long"));
        assertEquals(256, Base64.getDecoder().decode(Crypto.rsaPkcs1EncryptBase64(spki(), "x".repeat(245))).length);
    }
}
