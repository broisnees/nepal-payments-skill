package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.header;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "khalti" describe block of adapters.test.ts, plus Python-only and behaviour cases. */
class KhaltiTest {
    private final MockTransport http = new MockTransport();
    private final Khalti k = new Khalti(Khalti.Config.of(Environment.SANDBOX, "live_secret_key_test", "https://shop.example"), http);

    private static String lookup(String status) {
        return q("{'pidx':'P','total_amount':1000,'status':'" + status + "','transaction_id':'T','fee':0,'refunded':false}");
    }

    @Test
    @DisplayName("initiate: integer paisa, trailing slash, Key header")
    void initiate() {
        http.respond(q("{'pidx':'PIDX1','payment_url':'https://test-pay.khalti.com/?pidx=PIDX1','expires_at':'x','expires_in':1800}"));
        InitiateResult r = k.initiate(InitiateInput.of("O1", 1000, "Book", "https://shop.example/r"));
        assertEquals("https://dev.khalti.com/api/v2/epayment/initiate/", http.call(0).url());
        assertEquals("Key live_secret_key_test", header(http.call(0), "Authorization"));
        assertEquals(new BigDecimal("1000"), bodyJson(http.call(0)).get("amount"));
        assertEquals("redirect", r.kind());
        assertEquals("PIDX1", r.providerRef());
    }

    @Test
    @DisplayName("minimum Rs 10")
    void minimum() {
        PaymentException e = assertThrows(PaymentException.class, () -> k.initiate(InitiateInput.of("O", 999, "x", "https://r")));
        assertTrue(e.getMessage().contains("minimum"));
    }

    @Test
    @DisplayName("lookup: Expired arrives as HTTP 400 with a normal body")
    void expired400() {
        http.respond(400, q("{'pidx':'P','total_amount':1000,'status':'Expired','transaction_id':null,'fee':0,'refunded':false}"));
        assertEquals(PaymentStatus.EXPIRED, k.verify(VerifyInput.of("O", 1000).withProviderRef("P")).status());
    }

    @Test
    @DisplayName("lookup: Completed / User canceled / Partially Refunded")
    void lookupStatuses() {
        String[][] cases = {{"Completed", "paid"}, {"User canceled", "canceled"}, {"Partially refunded", "partially_refunded"}, {"Initiated", "pending"}};
        for (String[] c : cases) {
            http.respond(lookup(c[0]));
            assertEquals(c[1], k.verify(VerifyInput.of("O", 1000).withProviderRef("P")).status().wire());
        }
    }

    @Test
    @DisplayName("refuses callback pidx that differs from the stored one (replay guard)")
    void replayGuard() {
        PaymentException e = assertThrows(PaymentException.class,
                () -> k.verify(VerifyInput.of("O", 1000).withProviderRef("P").withCallback(Map.of("pidx", "OTHER"))));
        assertTrue(e.getMessage().contains("does not match"));
        assertTrue(http.calls.isEmpty());
    }

    @Test
    @DisplayName("401 surfaces as unauthorized")
    void unauthorized() {
        http.respond(401, q("{'detail':'Invalid token.','status_code':401}"));
        PaymentException e = assertThrows(PaymentException.class, () -> k.verify(VerifyInput.of("O", 1000).withProviderRef("P")));
        assertEquals("unauthorized", e.code());
    }

    // ---------------------------------------------------------------- Python-only case

    @Test
    @DisplayName("(python) lookup: User canceled arrives as HTTP 400 too")
    void pythonUserCanceled400() {
        http.respond(400, lookup("User canceled"));
        assertEquals(PaymentStatus.CANCELED, k.verify(VerifyInput.of("O", 1000).withProviderRef("P")).status());
    }

    // ---------------------------------------------------------------- behaviours from the brief

    @Test
    @DisplayName("verify posts the STORED pidx to lookup/ (trailing slash); paid carries integer paisa")
    void lookupUsesStoredPidx() {
        http.respond(lookup("Completed"));
        VerifyResult v = k.verify(VerifyInput.of("O", 1000).withProviderRef("P").withCallback(Map.of("pidx", "P", "purchase_order_id", "O")));
        assertEquals("https://dev.khalti.com/api/v2/epayment/lookup/", http.call(0).url());
        assertEquals("{\"pidx\":\"P\"}", http.call(0).body());
        assertEquals(1000L, v.amountPaisa());
        assertEquals("T", v.transactionId());
        assertEquals("missing_pidx", assertThrows(PaymentException.class, () -> k.verify(VerifyInput.of("O", 1000))).code());
        http.respond(404, q("{'detail':'Not found.'}"));
        assertEquals(PaymentStatus.NOT_FOUND, k.verify(VerifyInput.of("O", 1000).withProviderRef("P")).status());
    }

    @Test
    @DisplayName("refund: trailing slash, encoded id, paisa amount; errors keep Khalti's error_key")
    void refund() {
        http.respond(q("{'detail':'Transaction refund successful.'}"));
        k.refund("ab c/1", 500L, "98XXXXXXXX");
        assertEquals("https://dev.khalti.com/api/merchant-transaction/ab%20c%2F1/refund/", http.call(0).url());
        assertEquals("{\"amount\":500,\"mobile\":\"98XXXXXXXX\"}", http.call(0).body());
        http.respond(400, q("{'detail':'Already refunded','error_key':'validation_error'}"));
        PaymentException e = assertThrows(PaymentException.class, () -> k.refund("T"));
        assertEquals("validation_error", e.code());
        assertEquals("Khalti: Already refunded", e.getMessage());
    }
}
