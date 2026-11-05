package np.payments;

import static np.payments.MockTransport.bodyJson;
import static np.payments.MockTransport.q;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "nps" describe block of adapters.test.ts, plus the Python-only case. */
class NpsTest {
    private final MockTransport http = new MockTransport();
    private final Nps n = new Nps(Nps.Config.of(Environment.SANDBOX, "9", "TestMerchant", "u", "p", "secret"), http);

    private static String hmacHex(String message) {
        return Codec.toHex(Crypto.hmac(Crypto.Hash.SHA_512, "secret", message));
    }

    @Test
    @DisplayName("signature = HMAC-SHA512 hex of values of alphabetically sorted keys, no separator")
    void signature() {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("MerchantTxnId", "T1");
        p.put("MerchantName", "TestMerchant");
        p.put("Amount", "100");
        p.put("MerchantId", "9");
        assertEquals(hmacHex("100" + "9" + "TestMerchant" + "T1"), Nps.sign("secret", p));
        assertEquals(hmacHex("9TestMerchant"), Nps.sign("secret", Map.of("MerchantId", "9", "MerchantName", "TestMerchant")));
    }

    @Test
    @DisplayName("initiate: GetProcessId then multipart form with matching Amount/MerchantTxnId")
    void initiate() {
        http.respond(q("{'code':'0','message':'Success','errors':[],'data':{'ProcessId':'PROC_1'}}"));
        InitiateResult r = n.initiate(InitiateInput.of("T1", 10000, "x", "https://r"));
        assertEquals("https://apisandbox.nepalpayment.com/GetProcessId", http.call(0).url());
        Map<String, String> signed = new LinkedHashMap<>();
        signed.put("MerchantId", "9");
        signed.put("MerchantName", "TestMerchant");
        signed.put("Amount", "100");
        signed.put("MerchantTxnId", "T1");
        assertEquals(Nps.sign("secret", signed), bodyJson(http.call(0)).get("Signature"));
        InitiateResult.Form f = assertInstanceOf(InitiateResult.Form.class, r);
        assertEquals("multipart/form-data", f.enctype());
        assertEquals("100", f.fields().get("Amount"));
        assertEquals("PROC_1", f.fields().get("ProcessId"));
        assertEquals("https://gatewaysandbox.nepalpayment.com/Payment/Index", f.action());
    }

    @Test
    @DisplayName("status: code 0 + Fail is a failed payment; error_code 3 is not_found")
    void status() {
        http.respond(q("{'code':'0','message':'','errors':[],'data':{'Status':'Fail','Amount':'100','MerchantTxnId':'T1'}}"));
        assertEquals(PaymentStatus.FAILED, n.verify(VerifyInput.of("T1", 10000)).status());
        http.respond(q("{'code':'0','message':'','errors':[],'data':{'Status':'Success','Amount':'100.00','MerchantTxnId':'T1','GatewayReferenceNo':'G1'}}"));
        VerifyResult v = n.verify(VerifyInput.of("T1", 10000));
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals(10000L, v.amountPaisa());
        http.respond(q("{'code':'1','message':'','errors':[{'error_code':'3','error_message':'Transaction not initialized yet'}],'data':null}"));
        assertEquals(PaymentStatus.NOT_FOUND, n.verify(VerifyInput.of("T1", 10000)).status());
    }

    // ---------------------------------------------------------------- Python-only case + behaviours

    @Test
    @DisplayName("(python) initiate returns ProcessId as providerRef; Fail without Amount is failed")
    void pythonProviderRef() {
        http.respond(q("{'code':'0','message':'','errors':[],'data':{'ProcessId':'PROC_1'}}"));
        InitiateResult r = n.initiate(InitiateInput.of("T1", 10000, "x", "https://r"));
        assertEquals("PROC_1", r.providerRef());
        http.respond(q("{'code':'0','errors':[],'data':{'Status':'Fail','MerchantTxnId':'T1'}}"));
        assertEquals(PaymentStatus.FAILED, n.verify(VerifyInput.of("T1", 10000)).status());
    }

    @Test
    @DisplayName("other errors throw nps_<code>; wrong txn -> callback_mismatch; notification ack strings")
    void errorsAndNotification() {
        http.respond(q("{'code':'1','message':'bad','errors':[{'error_code':'7','error_message':'Invalid signature'}],'data':null}"));
        PaymentException e = assertThrows(PaymentException.class, () -> n.verify(VerifyInput.of("T1", 10000)));
        assertEquals("nps_7", e.code());
        assertEquals("NPS CheckTransactionStatus: Invalid signature", e.getMessage());
        http.respond(q("{'code':'0','errors':[],'data':{'Status':'Success','MerchantTxnId':'T9'}}"));
        assertEquals("callback_mismatch", assertThrows(PaymentException.class, () -> n.verify(VerifyInput.of("T1", 10000))).code());
        http.respond(401, "");
        assertEquals("unauthorized", assertThrows(PaymentException.class, () -> n.verify(VerifyInput.of("T1", 10000))).code());
        assertEquals("received", n.notificationResponse(false));
        assertEquals("already received", n.notificationResponse(true));
    }
}
