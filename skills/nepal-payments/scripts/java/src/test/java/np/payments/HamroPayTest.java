package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.math.BigDecimal;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of scripts/ts/test/providers/hamropay.test.ts. */
class HamroPayTest {
    private static final String MID = "PN_-Nd99TBnAlBjCgl8ef_b";
    private static final HamroPay.Config CFG = HamroPay.Config.of(Environment.SANDBOX, MID, "client@123", "merchant-api-key-test", "abcdefg")
            .withWebhookSecret("whsec");
    private final MockTransport http = new MockTransport();
    private final HamroPay h = new HamroPay(CFG, http);

    private static String jdk(String secret, String msg) {
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
            return Base64.getEncoder().encodeToString(mac.doFinal(msg.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static InitiateInput in(String orderId, long paisa) {
        return InitiateInput.of(orderId, paisa, "x", "https://a/");
    }

    @Test
    @DisplayName("signature: base64 HMAC-SHA512 over comma-joined values; commas refused")
    void signature() {
        assertEquals(jdk("abcdefg", "T1,1000,M,C,K"), HamroPay.sign("abcdefg", "T1", "1000", "M", "C", "K"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> HamroPay.sign("s", "a,b")).getMessage().contains("commas"));
    }

    @Test
    @DisplayName("initiate: Create Session signed in headers, then a signed gateway form")
    void initiate() {
        http.respond(q("{'sessionId':'ca8f7b70-b9c9-11ee-8611-0a73743c8233','merchantId':'" + MID + "'}"));
        InitiateResult r = h.initiate(InitiateInput.of("P1", 8992, "T-shirt", "https://shop.example/ok").withFailureUrl("https://shop.example/no"));
        assertEquals("https://uat-payclient.hamropatro.com/v1/checkout/sessionId", http.call(0).url());
        assertEquals("client@123", header(http.call(0), "Client-Id"));
        assertEquals("merchant-api-key-test", header(http.call(0), "Client-API-Key"));
        assertEquals("close", header(http.call(0), "Connection"));
        assertEquals(jdk("abcdefg", "P1,8992," + MID + ",client@123,merchant-api-key-test"), header(http.call(0), "Signature"));
        Map<String, Object> body = bodyJson(http.call(0));
        @SuppressWarnings("unchecked")
        Map<String, Object> product = ((List<Map<String, Object>>) body.get("productList")).get(0);
        assertEquals(List.of("P1", "8992", "https://shop.example/ok", "https://shop.example/no", new BigDecimal("89.92")),
                List.of(body.get("merchantTxnId"), body.get("transactionAmount"), body.get("successRedirectionUrl"), body.get("failedRedirectionUrl"), product.get("price")));
        assertEquals("form", r.kind());
        InitiateResult.Form f = assertInstanceOf(InitiateResult.Form.class, r);
        assertEquals("https://uat-checkout-pay.hamropatro.com/api/checkout", f.action());
        assertEquals("ca8f7b70-b9c9-11ee-8611-0a73743c8233", f.providerRef());
        assertEquals(jdk("abcdefg", MID + ",P1,ca8f7b70-b9c9-11ee-8611-0a73743c8233,8992,client@123,merchant-api-key-test"), f.fields().get("token"));
        assertEquals(List.of("merchant_id", "session_id", "token", "merchant_transaction_id", "remarks"), new ArrayList<>(f.fields().keySet()));
    }

    @Test
    @DisplayName("initiate: Rs 10..50,000, 25-char id, live gateway required, merchant echo checked")
    void initiateValidation() {
        assertTrue(assertThrows(PaymentException.class, () -> h.initiate(in("P1", 999))).getMessage().contains("Rs 10"));
        assertTrue(assertThrows(PaymentException.class, () -> h.initiate(in("P1", 5_000_001))).getMessage().contains("Rs 10"));
        assertTrue(assertThrows(PaymentException.class, () -> h.initiate(in("X".repeat(26), 1000))).getMessage().contains("1–25"));
        HamroPay live = new HamroPay(new HamroPay.Config(Environment.PRODUCTION, MID, "client@123", "merchant-api-key-test", "abcdefg", "whsec", null, null, null), http);
        assertTrue(assertThrows(IllegalStateException.class, () -> live.initiate(in("P1", 1000))).getMessage().contains("gatewayUrl"));
        http.respond(q("{'sessionId':'S','merchantId':'SOMEONE_ELSE'}"));
        assertEquals("merchant_mismatch", assertThrows(PaymentException.class, () -> h.initiate(in("P1", 1000))).code());
        http.respond(401, q("{'code':16,'message':'Unauthorized Request','details':[]}"));
        assertEquals("unauthorized", assertThrows(PaymentException.class, () -> h.initiate(in("P1", 1000))).code());
    }

    @Test
    @DisplayName("verify: Get Transaction signed, status mapping, rupees to paisa, id echo checked")
    void verify() {
        Object[][] cases = {
            {"{'merchantTxnId':'P1','status':'COMPLETED','amount':89.92,'trackingId':'TRK1'}", PaymentStatus.PAID, 8992L},
            {"{'merchantTransactionId':'P1','status':'PROCESSING','amount':0}", PaymentStatus.PENDING, null},
            {"{'merchantTxnId':'P1','status':'FAILED','amount':0}", PaymentStatus.FAILED, null},
            {"{'merchantTransactionId':'P1','trackingId':'','status':'NOT_INITIATED','amount':0,'message':'TRANSACTION NOT INITIATED YET'}", PaymentStatus.NOT_FOUND, null},
            {"{'merchantTxnId':'P1','status':'SOMETHING_NEW'}", PaymentStatus.UNKNOWN, null},
        };
        for (Object[] c : cases) {
            http.respond(q((String) c[0]));
            VerifyResult v = h.verify(VerifyInput.of("P1", 8992));
            assertEquals(c[1], v.status(), (String) c[0]);
            assertEquals(c[2], v.amountPaisa(), (String) c[0]);
            assertEquals("https://uat-payclient.hamropatro.com/v1/checkout/transaction", http.call(0).url());
            assertEquals(jdk("abcdefg", "P1," + MID + ",client@123,merchant-api-key-test"), header(http.call(0), "Signature"));
            assertEquals(Map.of("merchantId", MID, "merchantTxnId", "P1"), bodyJson(http.call(0)));
        }
        http.respond(q("{'merchantTxnId':'P2','status':'COMPLETED','amount':89.92}"));
        assertEquals("id_mismatch", assertThrows(PaymentException.class, () -> h.verify(VerifyInput.of("P1", 8992))).code());
        assertEquals(Optional.of("P1"), h.orderIdFromCallback(Map.of("MerchantTxnId", "P1")));
    }

    @Test
    @DisplayName("webhook: signature over merchantTxnId,merchantId,status,amount in any rendering of the amount")
    void webhook() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("merchantTxnId", "P1");
        body.put("merchantId", MID);
        body.put("amount", new BigDecimal("1200"));
        body.put("status", "COMPLETED");
        body.put("metadata", Map.of());
        for (String a : List.of("1200", "1200.0", "1200.00")) {
            assertTrue(h.verifyWebhook(body, jdk("whsec", "P1," + MID + ",COMPLETED," + a)), a);
        }
        Map<String, Object> b = new LinkedHashMap<>(body);
        b.put("amount", new BigDecimal("1.5"));
        assertTrue(h.verifyWebhook(b, jdk("whsec", "P1," + MID + ",COMPLETED,1.50")));
        b.put("amount", new BigDecimal("1201"));
        assertFalse(h.verifyWebhook(b, jdk("whsec", "P1," + MID + ",COMPLETED,1200")));
        b.put("amount", "1200");
        assertFalse(h.verifyWebhook(b, jdk("whsec", "P1," + MID + ",COMPLETED,1200")));
        assertFalse(h.verifyWebhook(body, null));
        HamroPay noSecret = new HamroPay(CFG.withWebhookSecret(null), http);
        assertTrue(assertThrows(IllegalStateException.class, () -> noSecret.verifyWebhook(body, "x")).getMessage().contains("webhookSecret"));
    }

    @Test
    @DisplayName("JdkHttpTransport: a Connection: close request goes through (HttpClient refuses the header itself)")
    void jdkTransportConnectionClose() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            byte[] out = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
        try {
            HttpTransport.Response res = new JdkHttpTransport().send(new HttpTransport.Request("POST",
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/", Map.of("Connection", "close"), "{}", Duration.ofSeconds(5)));
            assertEquals(200, res.status());
            assertEquals("{\"ok\":true}", res.body());
        } finally {
            server.stop(0);
        }
    }
    /** Loopback server that answers each connection with a chunked body whose terminating chunk never comes. */
    private static ServerSocket truncatingServer(int status, String body) throws Exception {
        ServerSocket ss = new ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
        Thread t = new Thread(() -> {
            while (!ss.isClosed()) {
                try (Socket c = ss.accept()) {
                    c.getInputStream().read(new byte[8192]);
                    byte[] b = body.getBytes(StandardCharsets.UTF_8);
                    String head = "HTTP/1.1 " + status + " X\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n"
                            + "Transfer-Encoding: chunked\r\n\r\n" + Integer.toHexString(b.length) + "\r\n";
                    c.getOutputStream().write(head.getBytes(StandardCharsets.US_ASCII));
                    c.getOutputStream().write(b);
                    c.getOutputStream().write("\r\n".getBytes(StandardCharsets.US_ASCII));
                    c.getOutputStream().flush();
                } catch (Exception ignored) {
                    // closed by the test, or the client hung up
                }
            }
        });
        t.setDaemon(true);
        t.start();
        return ss;
    }

    @Test
    @DisplayName("JdkHttpTransport: a truncated chunked body is kept when it is complete JSON, else network_error")
    void jdkTransportTruncatedBody() throws Exception {
        try (ServerSocket ss = truncatingServer(401, "{\"code\":16,\"message\":\"Unauthorized Request\",\"details\":[]}")) {
            HamroPay live = new HamroPay(CFG.withApiBaseUrl("http://127.0.0.1:" + ss.getLocalPort()), new JdkHttpTransport());
            PaymentException e = assertThrows(PaymentException.class, () -> live.verify(VerifyInput.of("P1", 1000)));
            assertEquals("unauthorized", e.code());
            assertEquals(401, e.httpStatus());
        }
        try (ServerSocket ss = truncatingServer(401, "{\"code\":16,\"mess")) {
            HamroPay live = new HamroPay(CFG.withApiBaseUrl("http://127.0.0.1:" + ss.getLocalPort()), new JdkHttpTransport());
            PaymentException e = assertThrows(PaymentException.class, () -> live.verify(VerifyInput.of("P1", 1000)));
            assertEquals("network_error", e.code());
        }
    }
}
