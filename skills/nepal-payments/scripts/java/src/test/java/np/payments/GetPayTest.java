package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of scripts/ts/test/providers/getpay.test.ts. */
class GetPayTest {
    private static final String OPR_KEY = "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5";
    private static final String PAP_INFO = btoa("{\"institutionId\":\"122\",\"mid\":\"123123451770986\",\"tid\":\"12358762\"}");
    private static final GetPay.Config CFG = GetPay.Config.of(Environment.SANDBOX, PAP_INFO, OPR_KEY, "https://shop.example", "Shop",
            "https://shop.example/logo.png");
    private static final String BASE = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions";
    private static final String ID = "0cc5b1a39f3c4cad864bc1c6a524534f";
    private static final String SECRET = sha256b64(OPR_KEY + ID);
    private static final String TOKEN = btoa("{\"id\":\"" + ID + "\",\"oprSecret\":\"" + SECRET + "\"}");

    private final MockTransport http = new MockTransport();
    private final GetPay g = new GetPay(CFG, http);

    private static String btoa(String s) {
        return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256b64(String s) {
        try {
            return Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static String ok(String data) {
        return q("{'status':0,'message':'SUCCESS','data':" + data + "}");
    }

    private VerifyInput withToken(String token) {
        return VerifyInput.of("P1", 120000).withCallback(Map.of("token", token));
    }

    @Test
    @DisplayName("oprSecret = base64(SHA-256(oprKey + id)); token decodes from JSON or id:secret")
    void token() {
        assertEquals(SECRET, GetPay.oprSecret(OPR_KEY, ID));
        assertEquals(Optional.of(new GetPay.Token(ID, SECRET)), GetPay.decodeToken(TOKEN));
        assertEquals(Optional.of(new GetPay.Token(ID, SECRET)), GetPay.decodeToken(btoa(ID + ":" + SECRET)));
        assertEquals(Optional.empty(), GetPay.decodeToken("%%%"));
        assertEquals(Optional.empty(), GetPay.decodeToken(btoa("{\"id\":\"" + ID + "\"}")));
    }

    @Test
    @DisplayName("initiate: SDK options with a numeric price, clientRequestId and same-origin callbacks")
    void initiate() {
        InitiateResult r = g.initiate(InitiateInput.of("P1", 120050, "Cup <set>", "https://shop.example/ok/P1").withFailureUrl("https://shop.example/no/P1"));
        assertEquals("sdk", r.kind());
        InitiateResult.Sdk s = assertInstanceOf(InitiateResult.Sdk.class, r);
        assertEquals("https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js", s.scriptUrl());
        assertEquals(1200.5, s.options().get("price"));
        assertEquals("P1", s.options().get("clientRequestId"));
        assertEquals(BASE, s.options().get("baseUrl"));
        assertEquals("", s.options().get("insKey"));
        assertEquals(Map.of("successUrl", "https://shop.example/ok/P1", "failUrl", "https://shop.example/no/P1"), s.options().get("callbackUrl"));
        assertTrue(String.valueOf(s.options().get("orderInformationUI")).contains("Cup &lt;set&gt;"));
        assertEquals("invalid_callback_url", assertThrows(PaymentException.class,
                () -> g.initiate(InitiateInput.of("P1", 100, "x", "https://evil.example/ok"))).code());
        String page = g.checkoutPage(s, "/pay/P1</script>");
        assertTrue(page.contains("new GetPay(o).initialize()"));
        assertTrue(!page.contains("</script>\"") && page.contains("\\u003c/script>"));
        assertTrue(g.paymentPage().contains("<div id=\"checkout\"></div>"));
        assertTrue(g.returnPage("/payments/getpay/return/P1").contains("window.top.location"));
    }

    @Test
    @DisplayName("verify with token: oprSecret checked, merchant-status, clientId must be this order")
    void verifyWithToken() {
        http.respond(ok("{'status':'SUCCESS','amount':1200.0,'currency':'NPR','stan':'379832','crrn':'624503379832','clientId':'P1','remarks':'Success'}"));
        VerifyResult v = g.verify(withToken(TOKEN));
        assertEquals(List.of(PaymentStatus.PAID, 120000L, ID), List.of(v.status(), v.amountPaisa(), v.transactionId()));
        assertEquals(BASE + "/merchant-status", http.call(0).url());
        assertEquals(Map.of("id", ID, "papInfo", PAP_INFO), bodyJson(http.call(0)));

        http.respond(ok("{'status':'SUCCESS','amount':1200.0,'clientId':'SOMEONE-ELSES-ORDER'}"));
        assertEquals("id_mismatch", assertThrows(PaymentException.class, () -> g.verify(withToken(TOKEN))).code());

        String forged = btoa("{\"id\":\"" + ID + "\",\"oprSecret\":\"" + btoa("not the hash") + "\"}");
        assertEquals("bad_signature", assertThrows(PaymentException.class, () -> g.verify(withToken(forged))).code());
        assertEquals("malformed_callback", assertThrows(PaymentException.class, () -> g.verify(withToken("@@"))).code());

        http.respond(ok("{'status':'FAILED','amount':1200.0,'clientId':'P1'}"));
        assertEquals(PaymentStatus.FAILED, g.verify(withToken(TOKEN)).status());
        http.respond(400, q("{'status':-1,'message':'Failed to fetch merchant information: Transaction not found for ID: " + ID + "'}"));
        assertEquals(PaymentStatus.NOT_FOUND, g.verify(withToken(TOKEN)).status());
    }

    @Test
    @DisplayName("verify without token: statement by clientRequestId; a success there is unknown, never paid")
    void verifyWithoutToken() {
        http.respond(ok("{'transactionId':'" + ID + "','clientRequestId':'P1','saleTransactionAmount':1200.0,'status':'SUCCESS','paymentScheme':'MASTERCARD'}"));
        VerifyResult v = g.verify(VerifyInput.of("P1", 120000));
        assertEquals(List.of(PaymentStatus.UNKNOWN, 120000L, ID), List.of(v.status(), v.amountPaisa(), v.transactionId()));
        assertEquals(BASE + "/transaction-statement", http.call(0).url());
        assertEquals(Map.of("clientRequestId", "P1"), bodyJson(http.call(0)));
        http.respond(ok("{'transactionId':'" + ID + "','clientRequestId':'P1','saleTransactionAmount':1200.0,'status':'FAILED'}"));
        assertEquals(PaymentStatus.FAILED, g.verify(VerifyInput.of("P1", 120000)).status());
        http.respond(400, q("{'status':-1,'message':'Failed to fetch transaction statement: Transaction not found for transaction ID: x'}"));
        assertEquals(PaymentStatus.NOT_FOUND, g.verify(VerifyInput.of("P1", 120000)).status());
        http.respond(500, "oops");
        assertThrows(PaymentException.class, () -> g.verify(VerifyInput.of("P1", 120000)));
        assertFalse(http.sleeps.isEmpty()); // 5xx retried before giving up
    }
}
