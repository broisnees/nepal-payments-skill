package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static np.payments.MockTransport.query;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "imepay" describe block of adapters.test.ts. */
class ImePayTest {
    private final MockTransport http = new MockTransport();
    private final ImePay i = new ImePay(ImePay.Config.of(Environment.SANDBOX, "MC", "u", "p", "MOD"), http);

    @Test
    @DisplayName("GetToken + checkout payload format (official plugin)")
    void getToken() {
        http.respond(q("{'TokenId':'TK1','ResponseCode':0}"));
        InitiateResult r = i.initiate(InitiateInput.of("R1", 10000, "x", "https://s/ok").withFailureUrl("https://s/no"));
        assertEquals("https://stg.imepay.com.np:7979/api/Web/GetToken", http.call(0).url());
        assertEquals(Base64.getEncoder().encodeToString("MOD".getBytes(StandardCharsets.UTF_8)), header(http.call(0), "Module"));
        assertEquals(Map.of("MerchantCode", "MC", "Amount", "100.00", "RefId", "R1"), bodyJson(http.call(0)));
        String data = query(assertInstanceOf(InitiateResult.Redirect.class, r).url()).get("data");
        assertEquals("TK1|MC|R1|100.00|POST|https://s/ok|https://s/no", new String(Base64.getDecoder().decode(data), StandardCharsets.ISO_8859_1));
    }

    @Test
    @DisplayName("Recheck: 0 = paid; anything else stays pending (sources disagree)")
    void recheck() {
        http.respond(q("{'ResponseCode':0,'RefId':'R1','TranAmount':'100.00','TransactionId':'X9'}"));
        assertEquals(PaymentStatus.PAID, i.verify(VerifyInput.of("R1", 10000).withProviderRef("TK1")).status());
        http.respond(q("{'ResponseCode':1,'RefId':'R1'}"));
        assertEquals(PaymentStatus.PENDING, i.verify(VerifyInput.of("R1", 10000).withProviderRef("TK1")).status());
        http.respond(q("{'ResponseCode':0,'RefId':'R1','TranAmount':''}"));
        assertNull(i.verify(VerifyInput.of("R1", 10000).withProviderRef("TK1")).amountPaisa()); // -> review, no throw
    }

    @Test
    @DisplayName("Recheck: amount/txn id parsed; missing token, wrong RefId and GetToken errors throw")
    void edges() {
        http.respond(q("{'ResponseCode':0,'RefId':'R1','TranAmount':'100.00','TransactionId':12345}"));
        VerifyResult v = i.verify(VerifyInput.of("R1", 10000).withProviderRef("TK1"));
        assertEquals(10000L, v.amountPaisa());
        assertEquals("12345", v.transactionId());
        assertEquals("missing_token", assertThrows(PaymentException.class, () -> i.verify(VerifyInput.of("R1", 1))).code());
        http.respond(q("{'ResponseCode':0,'RefId':'R2'}"));
        assertEquals("callback_mismatch", assertThrows(PaymentException.class, () -> i.verify(VerifyInput.of("R1", 1).withProviderRef("TK1"))).code());
        http.respond(q("{'TokenId':null,'ResponseCode':1,'ResponseDescription':'Invalid merchant'}"));
        PaymentException e = assertThrows(PaymentException.class, () -> i.initiate(InitiateInput.of("R1", 100, "x", "https://s")));
        assertEquals("imepay_1", e.code());
        assertEquals("IME Pay GetToken failed: Invalid merchant", e.getMessage());
    }
}
