package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.Signature;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Port of scripts/ts/test/providers/connectips.test.ts, plus .pfx loading and behaviour cases. */
class ConnectIpsTest {
    private static KeyPair kp;
    private static String pem;
    private final MockTransport http = new MockTransport();

    @BeforeAll
    static void keys() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        kp = g.generateKeyPair();
        String b64 = Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded());
        pem = "-----BEGIN PRIVATE KEY-----\n" + String.join("\n", b64.split("(?<=\\G.{64})")) + "\n-----END PRIVATE KEY-----";
    }

    private ConnectIps adapter() {
        return new ConnectIps(ConnectIps.Config.withPem(Environment.SANDBOX, "550", "MER-550-APP-1", "Test", "pw", pem), http);
    }

    private static boolean rsaVerify(PublicKey key, String b64Sig, String message) throws Exception {
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initVerify(key);
        s.update(message.getBytes(StandardCharsets.UTF_8));
        return s.verify(Codec.fromBase64(b64Sig));
    }

    @Test
    @DisplayName("TOKEN is RSA-SHA256 over the documented string, amount in paisa, DD-MM-YYYY")
    void token() throws Exception {
        InitiateResult r = adapter().initiate(InitiateInput.of("txn123", 500, "Order, #1", ""));
        assertEquals("form", r.kind());
        Map<String, String> f = assertInstanceOf(InitiateResult.Form.class, r).fields();
        assertEquals("500", f.get("TXNAMT"));
        assertTrue(f.get("TXNDATE").matches("^\\d{2}-\\d{2}-\\d{4}$"));
        assertEquals("Order  #1", f.get("REMARKS")); // commas stripped: they'd corrupt the token string
        String msg = ConnectIps.tokenString(f);
        assertTrue(msg.endsWith(",PARTICULARS=Order  #1,TOKEN=TOKEN"));
        assertTrue(rsaVerify(kp.getPublic(), f.get("TOKEN"), msg));
    }

    @Test
    @DisplayName("TXNID max 20 chars")
    void txnIdMax() {
        PaymentException e = assertThrows(PaymentException.class, () -> adapter().initiate(InitiateInput.of("X".repeat(21), 100, "x", "")));
        assertTrue(e.getMessage().contains("1–20"));
    }

    @Test
    @DisplayName("validatetxn: referenceId = TXNID, Basic auth, status mapping")
    void validatetxn() {
        ConnectIps c = adapter();
        String[][] cases = {{"SUCCESS", "TRANSACTION SUCCESSFUL", "paid"}, {"FAILED", "TRANSACTION UNSUCCESSFUL", "failed"},
                {"ERROR", "TRANSACTION NOT FOUND", "not_found"}, {"ERROR", "TRANSACTION INCOMPLETE", "pending"}};
        for (String[] cs : cases) {
            http.respond(q("{'merchantId':550,'appId':'MER-550-APP-1','referenceId':'txn123','txnAmt':'500','status':'" + cs[0] + "','statusDesc':'" + cs[1] + "'}"));
            VerifyResult v = c.verify(VerifyInput.of("txn123", 500));
            assertEquals(cs[2], v.status().wire());
            Map<String, Object> body = bodyJson(http.call(0));
            assertEquals("txn123", body.get("referenceId"));
            assertEquals(new BigDecimal("500"), body.get("txnAmt"));
            assertEquals("Basic " + Base64.getEncoder().encodeToString("MER-550-APP-1:pw".getBytes(StandardCharsets.UTF_8)), header(http.call(0), "Authorization"));
            assertEquals("https://uat.connectips.com/connectipswebws/api/creditor/validatetxn", http.call(0).url());
        }
    }

    // ---------------------------------------------------------------- behaviours from the brief + Java-only

    @Test
    @DisplayName("clip strips ',' and '='; validatetxn token signs MERCHANTID,APPID,REFERENCEID=TXNID,TXNAMT; Kathmandu date")
    void clipTokenAndDate() throws Exception {
        ConnectIps c = adapter();
        Map<String, String> f = ((InitiateResult.Form) c.initiate(InitiateInput.of("txn123", 500, "a=b,c", ""),
                new ConnectIps.Extras("REF=1", null, null))).fields();
        assertEquals("a b c", f.get("REMARKS"));
        assertEquals("REF 1", f.get("REFERENCEID"));
        assertEquals("https://uat.connectips.com/connectipswebgw/loginpage", ((InitiateResult.Form) c.initiate(InitiateInput.of("t", 1, "x", ""))).action());

        http.respond(q("{'status':'SUCCESS','statusDesc':'TRANSACTION SUCCESSFUL','txnAmt':'500'}"));
        VerifyResult v = c.verify(VerifyInput.of("txn123", 500));
        assertEquals(500L, v.amountPaisa());
        Map<String, Object> body = bodyJson(http.call(0));
        assertEquals(new BigDecimal("550"), body.get("merchantId"));
        assertTrue(rsaVerify(kp.getPublic(), (String) body.get("token"), "MERCHANTID=550,APPID=MER-550-APP-1,REFERENCEID=txn123,TXNAMT=500"));
        assertEquals("05-11-2026", ConnectIps.date(Instant.parse("2026-11-04T20:00:00Z")));

        http.respond(401, "");
        assertEquals("unauthorized", assertThrows(PaymentException.class, () -> c.verify(VerifyInput.of("txn123", 500))).code());
    }

    @Test
    @DisplayName("PKCS#1 PEM is rejected with the conversion command")
    void pkcs1Rejected() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> Crypto.privateKeyFromPem("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"));
        assertTrue(e.getMessage().contains("openssl pkcs8 -topk8"));
    }

    @Test
    @DisplayName("creditor .pfx loads natively via KeyStore(PKCS12) and signs a verifiable TOKEN")
    void pkcs12(@TempDir Path dir) throws Exception {
        Path pfx = dir.resolve("CREDITOR.pfx");
        String keytool = Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win") ? "keytool.exe" : "keytool").toString();
        Process p = new ProcessBuilder(keytool, "-genkeypair", "-alias", "creditor", "-keyalg", "RSA", "-keysize", "2048",
                "-dname", "CN=Test Creditor", "-validity", "2", "-storetype", "PKCS12", "-keystore", pfx.toString(),
                "-storepass", "secret123", "-keypass", "secret123").redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.waitFor(), out);

        ConnectIps c = new ConnectIps(ConnectIps.Config.withPkcs12(Environment.SANDBOX, "550", "MER-550-APP-1", "Test", "pw", pfx, "secret123".toCharArray()), http);
        Map<String, String> f = ((InitiateResult.Form) c.initiate(InitiateInput.of("txn123", 500, "x", ""))).fields();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(pfx)) {
            ks.load(in, "secret123".toCharArray());
        }
        assertTrue(rsaVerify(ks.getCertificate("creditor").getPublicKey(), f.get("TOKEN"), ConnectIps.tokenString(f)));
        assertThrows(IllegalArgumentException.class, () -> Crypto.privateKeyFromPkcs12(pfx, "wrong".toCharArray()));
        assertEquals(List.of("MERCHANTID", "APPID", "APPNAME", "TXNID", "TXNDATE", "TXNCRNCY", "TXNAMT", "REFERENCEID", "REMARKS", "PARTICULARS", "TOKEN"),
                List.copyOf(f.keySet()));
    }
}
