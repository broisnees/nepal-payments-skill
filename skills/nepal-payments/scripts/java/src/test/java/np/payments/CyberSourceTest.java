package np.payments;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "cybersource" describe block of adapters.test.ts, plus the Python-only case. */
class CyberSourceTest {
    private final CyberSource cs = new CyberSource(CyberSource.Config.of(Environment.SANDBOX, "P", "A", "S"));

    @Test
    @DisplayName("Secure Acceptance signature worked example")
    void workedExample() {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("access_key", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
        f.put("profile_id", "PROFILE-0001");
        f.put("transaction_uuid", "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f");
        f.put("signed_field_names", "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency");
        f.put("unsigned_field_names", "");
        f.put("signed_date_time", "2026-11-04T10:15:30Z");
        f.put("locale", "en-us");
        f.put("transaction_type", "sale");
        f.put("reference_number", "ORDER-1001");
        f.put("amount", "1500.00");
        f.put("currency", "NPR");
        assertEquals("QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=", CyberSource.sign("test_secret_key_do_not_use", f));
    }

    /** Signed response with every field listed in signed_field_names (TS helper `response`). */
    private static Map<String, String> response(String... kv) {
        Map<String, String> p = new LinkedHashMap<>();
        p.put("req_reference_number", "ORD-1");
        p.put("req_currency", "NPR");
        p.put("req_transaction_type", "sale");
        p.put("transaction_id", "7000");
        for (int i = 0; i < kv.length; i += 2) p.put(kv[i], kv[i + 1]);
        List<String> names = new ArrayList<>(p.keySet());
        names.add("signed_field_names");
        p.put("signed_field_names", String.join(",", names));
        p.put("signature", CyberSource.sign("S", p));
        return p;
    }

    private VerifyResult verify(String orderId, Map<String, String> callback) {
        return cs.verify(VerifyInput.of(orderId, 150000).withCallback(callback));
    }

    @Test
    @DisplayName("decisions map correctly; unsigned extra fields ignored; tamper rejected")
    void decisions() {
        assertEquals(PaymentStatus.PAID, verify("ORD-1", response("decision", "ACCEPT", "reason_code", "100", "auth_amount", "1500.00")).status());
        assertEquals(PaymentStatus.FAILED, verify("ORD-1", response("decision", "DECLINE", "reason_code", "203")).status());
        assertEquals(PaymentStatus.PENDING, verify("ORD-1", response("decision", "REVIEW", "reason_code", "200")).status());
        assertEquals(PaymentStatus.CANCELED, verify("ORD-1", response("decision", "CANCEL", "reason_code", "")).status());
        Map<String, String> ok = response("decision", "ACCEPT", "reason_code", "100", "auth_amount", "1500.00");
        Map<String, String> injected = new LinkedHashMap<>(ok);
        injected.put("injected", "x");
        VerifyResult v = verify("ORD-1", injected);
        assertFalse(((Map<?, ?>) v.raw()).containsKey("injected"));
        Map<String, String> tampered = new LinkedHashMap<>(ok);
        tampered.put("auth_amount", "1.00");
        assertTrue(assertThrows(PaymentException.class, () -> verify("ORD-1", tampered)).getMessage().contains("invalid response signature"));
        assertTrue(assertThrows(PaymentException.class, () -> verify("ORD-2", ok)).getMessage().contains("different order"));
        // signed-but-empty auth_amount falls back to req_amount (same as Python)
        Map<String, String> empty = response("decision", "ACCEPT", "reason_code", "100", "auth_amount", "", "req_amount", "1500.00");
        assertEquals(150000L, verify("ORD-1", empty).amountPaisa());
    }

    @Test
    @DisplayName("initiate signs every field incl. bill_to and sends unsigned_field_names empty")
    void initiate() {
        InitiateResult r = cs.initiate(InitiateInput.of("ORD-1", 150000, "x", "https://r"),
                CyberSource.BillTo.of("Ram", "Sharma", "r@e.com", "Thamel", "Kathmandu", "NP"));
        Map<String, String> f = assertInstanceOf(InitiateResult.Form.class, r).fields();
        assertEquals("1500.00", f.get("amount"));
        assertEquals("", f.get("unsigned_field_names"));
        assertTrue(f.get("signed_date_time").matches("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$"));
        assertTrue(f.get("signed_field_names").contains("bill_to_address_country"));
        assertEquals(CyberSource.sign("S", f), f.get("signature"));
    }

    // ---------------------------------------------------------------- Python-only case + behaviours

    @Test
    @DisplayName("(python) ACCEPT carries auth_amount as paisa; tamper rejected")
    void pythonPaidAmount() {
        VerifyResult v = verify("ORD-1", response("decision", "ACCEPT", "reason_code", "100", "auth_amount", "1500.00"));
        assertEquals(PaymentStatus.PAID, v.status());
        assertEquals(150000L, v.amountPaisa());
        assertEquals("7000", v.transactionId());
    }

    @Test
    @DisplayName("signed_field_names order, reason 150 -> unknown, auth-only -> pending, no callback -> verify_unavailable")
    void edges() {
        Map<String, String> f = ((InitiateResult.Form) cs.initiate(InitiateInput.of("ORD-1", 150000, "x", "https://r"),
                CyberSource.BillTo.of("Ram", "Sharma", "r@e.com", "Thamel", "Kathmandu", "NP"), Map.of(2, "b", 1, "a"))).fields();
        assertTrue(f.get("signed_field_names").startsWith("access_key,profile_id,transaction_uuid,signed_date_time,locale,transaction_type,reference_number,amount,currency,bill_to_forename"));
        assertTrue(f.get("signed_field_names").endsWith("merchant_defined_data1,merchant_defined_data2,unsigned_field_names,signed_field_names"));
        assertEquals(PaymentStatus.UNKNOWN, verify("ORD-1", response("decision", "ERROR", "reason_code", "150")).status());
        assertEquals(PaymentStatus.PENDING, verify("ORD-1", response("decision", "ACCEPT", "reason_code", "100", "req_transaction_type", "authorization")).status());
        assertEquals("verify_unavailable", assertThrows(PaymentException.class, () -> cs.verify(VerifyInput.of("ORD-1", 1))).code());
        assertEquals("currency_mismatch", assertThrows(PaymentException.class,
                () -> verify("ORD-1", response("decision", "ACCEPT", "req_currency", "USD"))).code());
        assertThrows(IllegalArgumentException.class, () -> cs.initiate(InitiateInput.of("ORD-1", 1, "x", "https://r")));
    }
}
