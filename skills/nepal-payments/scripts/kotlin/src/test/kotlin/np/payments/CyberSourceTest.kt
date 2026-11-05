package np.payments

import org.junit.jupiter.api.DisplayName
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CyberSourceTest {
    private val cs = CyberSource(CyberSourceConfig(Environment.SANDBOX, "P", "A", "S"))

    private fun response(o: Map<String, String>): Map<String, String> {
        val p = linkedMapOf("req_reference_number" to "ORD-1", "req_currency" to "NPR", "req_transaction_type" to "sale", "transaction_id" to "7000")
        p.putAll(o)
        p["signed_field_names"] = (p.keys + "signed_field_names").joinToString(",")
        p["signature"] = cybersourceSign("S", p)
        return p
    }

    private suspend fun status(o: Map<String, String>) = cs.verify(VerifyInput("ORD-1", 150000, callback = response(o))).status

    @Test
    @DisplayName("[ts] Secure Acceptance signature worked example")
    fun vector() {
        val f = linkedMapOf(
            "access_key" to "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            "profile_id" to "PROFILE-0001",
            "transaction_uuid" to "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
            "signed_field_names" to "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency",
            "unsigned_field_names" to "",
            "signed_date_time" to "2026-11-04T10:15:30Z",
            "locale" to "en-us",
            "transaction_type" to "sale",
            "reference_number" to "ORDER-1001",
            "amount" to "1500.00",
            "currency" to "NPR",
        )
        assertEquals("QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=", cybersourceSign("test_secret_key_do_not_use", f))
    }

    @Test
    @DisplayName("[ts] decisions map correctly; unsigned extra fields ignored; tamper rejected")
    fun decisions() = suspendTest {
        assertEquals(PaymentStatus.PAID, status(mapOf("decision" to "ACCEPT", "reason_code" to "100", "auth_amount" to "1500.00")))
        assertEquals(PaymentStatus.FAILED, status(mapOf("decision" to "DECLINE", "reason_code" to "203")))
        assertEquals(PaymentStatus.PENDING, status(mapOf("decision" to "REVIEW", "reason_code" to "200")))
        assertEquals(PaymentStatus.CANCELED, status(mapOf("decision" to "CANCEL", "reason_code" to "")))
        val ok = response(mapOf("decision" to "ACCEPT", "reason_code" to "100", "auth_amount" to "1500.00"))
        val v = cs.verify(VerifyInput("ORD-1", 150000, callback = ok + ("injected" to "x")))
        assertNull((v.raw as Map<*, *>)["injected"])
        assertContains(
            assertFailsWith<PaymentException> { cs.verify(VerifyInput("ORD-1", 150000, callback = ok + ("auth_amount" to "1.00"))) }.message!!,
            "invalid response signature",
        )
        assertContains(assertFailsWith<PaymentException> { cs.verify(VerifyInput("ORD-2", 150000, callback = ok)) }.message!!, "different order")
        // signed-but-empty auth_amount falls back to req_amount (same as Python)
        val empty = response(mapOf("decision" to "ACCEPT", "reason_code" to "100", "auth_amount" to "", "req_amount" to "1500.00"))
        assertEquals(150000, cs.verify(VerifyInput("ORD-1", 150000, callback = empty)).amountPaisa)
    }

    @Test
    @DisplayName("[ts] initiate signs every field incl. bill_to and sends unsigned_field_names empty")
    fun initiate() = suspendTest {
        val r = cs.initiate(
            InitiateInput("ORD-1", 150000, "x", "https://r"),
            CyberSourceInitiateExtras(BillTo("Ram", "Sharma", "r@e.com", "Thamel", "Kathmandu", "NP")),
        ) as InitiateResult.Form
        assertEquals("1500.00", r.fields["amount"])
        assertEquals("", r.fields["unsigned_field_names"])
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$").matches(r.fields.getValue("signed_date_time")))
        assertContains(r.fields.getValue("signed_field_names"), "bill_to_address_country")
        assertEquals(cybersourceSign("S", r.fields), r.fields["signature"])
    }

    @Test
    @DisplayName("[py] ACCEPT carries the paid amount in paisa")
    fun paidAmount() = suspendTest {
        val v = cs.verify(VerifyInput("ORD-1", 150000, callback = response(mapOf("decision" to "ACCEPT", "reason_code" to "100", "auth_amount" to "1500.00"))))
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(150000, v.amountPaisa)
        assertEquals("7000", v.transactionId)
    }

    @Test
    @DisplayName("[kt] signed_field_names order; signed-but-empty auth_amount alone -> null; currency + system errors")
    fun edges() = suspendTest {
        val r = cs.initiate(
            InitiateInput("ORD-1", 150000, "x", "https://r"),
            CyberSourceInitiateExtras(BillTo("Ram", "Sharma", "r@e.com", "Thamel", "Kathmandu", "NP", phone = "98"), mapOf(2 to "b", 1 to "a")),
        ) as InitiateResult.Form
        assertEquals(
            "access_key,profile_id,transaction_uuid,signed_date_time,locale,transaction_type,reference_number,amount,currency," +
                "bill_to_forename,bill_to_surname,bill_to_email,bill_to_address_line1,bill_to_address_city,bill_to_address_country," +
                "bill_to_phone,merchant_defined_data1,merchant_defined_data2,unsigned_field_names,signed_field_names",
            r.fields["signed_field_names"],
        )
        assertNull(cs.verify(VerifyInput("ORD-1", 1, callback = response(mapOf("decision" to "ACCEPT", "reason_code" to "100", "auth_amount" to "")))).amountPaisa)
        assertEquals("currency_mismatch", assertFailsWith<PaymentException> { cs.verify(VerifyInput("ORD-1", 1, callback = response(mapOf("req_currency" to "USD")))) }.code)
        assertEquals(PaymentStatus.UNKNOWN, status(mapOf("decision" to "ERROR", "reason_code" to "150")))
        assertEquals("verify_unavailable", assertFailsWith<PaymentException> { cs.verify(VerifyInput("ORD-1", 1)) }.code)
        assertFailsWith<IllegalArgumentException> { cs.initiate(InitiateInput("ORD-1", 1, "x", "https://r")) }
    }
}
