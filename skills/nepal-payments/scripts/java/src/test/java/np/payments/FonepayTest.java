package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static np.payments.MockTransport.query;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "fonepay" describe block of adapters.test.ts, plus behaviour cases. */
class FonepayTest {
    private static final String SECRET = "a7e3512f5032480a83137793cb2021dc"; // public dev sample (spec v2.0)
    private static final List<String> DV_FIELDS = List.of("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT");
    private final MockTransport http = new MockTransport();

    private Fonepay sandbox() {
        return new Fonepay(Fonepay.Config.of(Environment.SANDBOX, "NBQM", SECRET), http);
    }

    private static Map<String, String> signedCallback(String... kv) {
        Map<String, String> cb = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) cb.put(kv[i], kv[i + 1]);
        List<String> values = new ArrayList<>();
        for (String f : DV_FIELDS) values.add(cb.get(f));
        cb.put("DV", Fonepay.hmac(SECRET, values));
        return cb;
    }

    @Test
    @DisplayName("response DV test vector (spec v2.0)")
    void responseDvVector() {
        assertEquals("667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52",
                Fonepay.hmac(SECRET, List.of("d1580724437729", "NBQM", "true", "successful", "36463", "NICENPKA", "9841845631", "20.0", "30")));
    }

    @Test
    @DisplayName("txnVerification `auth` header matches spec example byte-for-byte")
    void txnVerificationAuth() {
        Fonepay fp = new Fonepay(Fonepay.Config.of(Environment.PRODUCTION, "NBQM", SECRET).withLogin("gnw71090@zwoho.com", "Fonepay@12345"), http);
        http.respond(q("{'paymentStatus':'success','prn':'d1549791827186','requestedAmount':'30','fonepayTraceId':12847}"));
        VerifyResult v = fp.verify(VerifyInput.of("d1549791827186", 3000));
        assertEquals("{\"prn\": \"d1549791827186\",\"merchantCode\": \"NBQM\",\"amount\": \"30\"}", http.call(0).body());
        assertEquals("0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2",
                header(http.call(0), "auth"));
        assertEquals("Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=", header(http.call(0), "Authorization"));
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals(3000L, v.amountPaisa());
        assertEquals("12847", v.transactionId());
    }

    @Test
    @DisplayName("Dynamic QR dataValidation matches spec example")
    void qrDataValidation() {
        Fonepay fp = new Fonepay(Fonepay.Config.of(Environment.PRODUCTION, "NBQM", SECRET).withLogin("u", "p"), http);
        http.respond(q("{'qrMessage':'000201...','status':'CREATED','thirdpartyQrWebSocketUrl':'wss://localhost:8080/x'}"));
        Fonepay.QrCreated r = fp.qrCreate("5d76d323-d1f6", 1400, "test1", "test2");
        assertEquals("5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf",
                bodyJson(http.call(0)).get("dataValidation"));
        assertEquals("wss://ws.fonepay.com/x", r.webSocketUrl()); // localhost host rewritten
    }

    @Test
    @DisplayName("initiate: DV over raw values, PRN length enforced, Kathmandu date")
    void initiate() {
        Fonepay fp = sandbox();
        InitiateResult r = fp.initiate(InitiateInput.of("NP123", 1050, "Order 1", "https://s.example/r"));
        assertEquals("redirect", r.kind());
        Map<String, String> qs = query(assertInstanceOf(InitiateResult.Redirect.class, r).url());
        assertEquals("10.50", qs.get("AMT"));
        assertTrue(qs.get("DT").matches("^\\d{2}/\\d{2}/\\d{4}$"));
        assertEquals(Fonepay.hmac(SECRET, List.of("NBQM", "P", "NP123", "10.50", "NPR", qs.get("DT"), "Order 1", "N/A", "https://s.example/r")), qs.get("DV"));
        PaymentException e = assertThrows(PaymentException.class, () -> fp.initiate(InitiateInput.of("X".repeat(26), 100, "x", "https://r")));
        assertTrue(e.getMessage().contains("3–25"));
        assertEquals("11/05/2026", Fonepay.date(Instant.parse("2026-11-04T20:00:00Z"))); // already the 5th in Nepal (UTC+5:45)
    }

    @Test
    @DisplayName("forged callback without DV cannot force failed (legacy path)")
    void forgedCallback() {
        Map<String, String> forged = Map.of("PRN", "NP123", "PID", "NBQM", "PS", "false", "RC", "failed", "UID", "x", "BC", "y");
        assertEquals("invalid_signature", assertThrows(PaymentException.class,
                () -> sandbox().verify(VerifyInput.of("NP123", 1000).withCallback(forged))).code());
        Fonepay lax = new Fonepay(Fonepay.Config.of(Environment.SANDBOX, "NBQM", SECRET).withStrictSignature(false), http);
        assertEquals("verify_unavailable", assertThrows(PaymentException.class,
                () -> lax.verify(VerifyInput.of("NP123", 1000).withCallback(forged))).code());
    }

    @Test
    @DisplayName("legacy verification: upstream 5xx throws instead of reading as failed")
    void legacyUpstream5xx() {
        Fonepay fp = sandbox();
        Map<String, String> cb = signedCallback("PRN", "NP123", "PID", "NBQM", "PS", "true", "RC", "successful", "UID", "36463", "BC", "NICENPKA",
                "INI", "98", "P_AMT", "10", "R_AMT", "10");
        http.respond(502, "<html>Bad Gateway</html>");
        assertEquals("upstream_error", assertThrows(PaymentException.class, () -> fp.verify(VerifyInput.of("NP123", 1000).withCallback(cb))).code());
        http.respond("<response><response_code>successful</response_code><success>true</success></response>");
        VerifyResult v = fp.verify(VerifyInput.of("NP123", 1000).withCallback(cb));
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals(1000L, v.amountPaisa());
    }

    @Test
    @DisplayName("callback DV verified case-insensitively; tamper rejected")
    void callbackDvCaseInsensitive() {
        Fonepay fp = sandbox();
        Map<String, String> cb = signedCallback("PRN", "d1580724437729", "PID", "NBQM", "PS", "true", "RC", "successful", "UID", "36463",
                "BC", "NICENPKA", "INI", "9841845631", "P_AMT", "20.0", "R_AMT", "30");
        cb.put("DV", cb.get("DV").toLowerCase());
        assertTrue(fp.callbackValid(cb));
        Map<String, String> tampered = new LinkedHashMap<>(cb);
        tampered.put("R_AMT", "3");
        assertFalse(fp.callbackValid(tampered));
    }

    // ---------------------------------------------------------------- behaviours from the brief

    @Test
    @DisplayName("legacy verification: request DV + params; unparseable 200 throws malformed_response; signed negative needs no HTTP")
    void legacyDetails() {
        Fonepay fp = sandbox();
        Map<String, String> cb = signedCallback("PRN", "NP123", "PID", "NBQM", "PS", "true", "RC", "successful", "UID", "1", "BC", "B",
                "INI", "9", "P_AMT", "10", "R_AMT", "10");
        http.respond("<html>maintenance</html>");
        assertEquals("malformed_response", assertThrows(PaymentException.class, () -> fp.verify(VerifyInput.of("NP123", 1000).withCallback(cb))).code());
        Map<String, String> qs = query(http.call(0).url());
        assertEquals(Fonepay.hmac(SECRET, List.of("NBQM", "10", "NP123", "B", "1")), qs.get("DV"));
        assertEquals("application/xml", header(http.call(0), "Accept"));

        http.respond("<response><response_code>failed</response_code><success>false</success></response>");
        assertEquals(PaymentStatus.FAILED, fp.verify(VerifyInput.of("NP123", 1000).withCallback(cb)).status());

        http.respond(500, "should not be called");
        Map<String, String> canceled = signedCallback("PRN", "NP123", "PID", "NBQM", "PS", "false", "RC", "cancel", "UID", "1", "BC", "B",
                "INI", "9", "P_AMT", "10", "R_AMT", "10");
        VerifyResult v = fp.verify(VerifyInput.of("NP123", 1000).withCallback(canceled));
        assertEquals(PaymentStatus.CANCELED, v.status());
        assertNull(v.amountPaisa());
        assertTrue(http.calls.isEmpty());

        Map<String, String> other = signedCallback("PRN", "OTHER", "PID", "NBQM", "PS", "true", "RC", "successful", "UID", "1", "BC", "B",
                "INI", "9", "P_AMT", "10", "R_AMT", "10");
        assertEquals("callback_mismatch", assertThrows(PaymentException.class, () -> fp.verify(VerifyInput.of("NP123", 1000).withCallback(other))).code());
    }

    @Test
    @DisplayName("initiate limits: PRN min 3, RU <= 150; qrStatus + sandbox websocket rewrite")
    void limitsAndQr() {
        Fonepay fp = sandbox();
        assertEquals("invalid_order_id", assertThrows(PaymentException.class, () -> fp.initiate(InitiateInput.of("AB", 100, "x", "https://r"))).code());
        assertEquals("invalid_return_url", assertThrows(PaymentException.class,
                () -> fp.initiate(InitiateInput.of("ABC", 100, "x", "https://r/" + "a".repeat(141)))).code());
        assertThrows(IllegalStateException.class, () -> fp.qrStatus("ABC"));

        Fonepay qr = new Fonepay(Fonepay.Config.of(Environment.SANDBOX, "NBQM", SECRET).withLogin("u", "p"), http);
        http.respond(q("{'qrMessage':'0002','thirdpartyQrWebSocketUrl':'ws://localhost:1/x'}"));
        assertEquals("wss://dev-ws.fonepay.com/x", qr.qrCreate("ABC", 100, "r1").webSocketUrl());
        http.respond(q("{'paymentStatus':'success','fonepayTraceId':99}"));
        VerifyResult v = qr.qrStatus("ABC", 100L);
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals("99", v.transactionId());
        assertEquals(100L, v.amountPaisa());
        assertEquals(Fonepay.hmac(SECRET, List.of("ABC", "NBQM")).toLowerCase(), bodyJson(http.call(0)).get("dataValidation"));
    }
}
