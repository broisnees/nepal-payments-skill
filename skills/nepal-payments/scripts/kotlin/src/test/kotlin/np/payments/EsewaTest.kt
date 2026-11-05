package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EsewaTest {
    private val mock = MockTransport()
    private val e = Esewa(EsewaSandbox.config(), mock)
    private val order = listOf("total_amount", "transaction_uuid", "product_code")

    private fun successData(overrides: Map<String, String> = emptyMap()): Map<String, String> {
        val p = linkedMapOf(
            "transaction_code" to "000AWEO",
            "status" to "COMPLETE",
            "total_amount" to "1000.0",
            "transaction_uuid" to "ORD-2",
            "product_code" to "EPAYTEST",
            "signed_field_names" to "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
        )
        p.putAll(overrides)
        p["signature"] = esewaSign(EsewaSandbox.SECRET_KEY, p, p.getValue("signed_field_names").split(","))
        return p
    }

    @Test
    @DisplayName("[ts] signature test vectors (docs' own examples are wrong; these are verified)")
    fun vectors() {
        val k = EsewaSandbox.SECRET_KEY
        assertEquals(
            "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=",
            esewaSign(k, mapOf("total_amount" to "100", "transaction_uuid" to "11-201-13", "product_code" to "EPAYTEST"), order),
        )
        assertEquals(
            "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=",
            esewaSign(k, mapOf("total_amount" to "110", "transaction_uuid" to "ab14a8f2b02c3", "product_code" to "EPAYTEST"), order),
        )
        assertEquals(
            "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=",
            esewaSign(
                EsewaSandbox.INTENT_ACCESS_KEY,
                mapOf("product_code" to "INTENT", "amount" to "100", "transaction_uuid" to "txn-20251220-001"),
                listOf("product_code", "amount", "transaction_uuid"),
            ),
        )
    }

    @Test
    @DisplayName("[ts] initiate: amountPaisa is the total; breakdown included; same string signed and posted")
    fun initiateTotal() = suspendTest {
        val r = e.initiate(InitiateInput("ORD-1", 11050, "x", "https://s/r/ORD-1"), EsewaInitiateExtras(taxPaisa = 1000)) as InitiateResult.Form
        assertEquals("110.50", r.fields["total_amount"])
        assertEquals("100.50", r.fields["amount"])
        val err = assertFailsWith<PaymentException> {
            e.initiate(InitiateInput("ORD-1", 1000, "x", "https://s"), EsewaInitiateExtras(taxPaisa = 1000))
        }
        assertContains(err.message!!, "less than the total")
        assertEquals(esewaSign(EsewaSandbox.SECRET_KEY, r.fields, order), r.fields["signature"])
        assertEquals("https://rc-epay.esewa.com.np/api/epay/main/v2/form", r.action)
    }

    @Test
    @DisplayName("[ts] rejects uuid with forbidden characters")
    fun rejectsUuid() = suspendTest {
        val err = assertFailsWith<PaymentException> { e.initiate(InitiateInput("a_b", 100, "x", "https://s")) }
        assertContains(err.message!!, "letters, digits")
    }

    @Test
    @DisplayName("[ts] success payload signature verifies; tamper fails; comma variant accepted")
    fun successPayload() {
        val p = successData()
        val data = b64(Json.stringify(p))
        assertTrue(e.parseSuccess(data).signatureValid)
        assertTrue(e.parseSuccess(data.replace('+', ' ')).signatureValid) // '+' -> ' ' in query
        val tampered = b64(Json.stringify(p + ("total_amount" to "1.0")))
        assertFalse(e.parseSuccess(tampered).signatureValid)
        // eSewa signs "1000.0" but displays "1,000.0"
        val shown = b64(Json.stringify(p + ("total_amount" to "1,000.0")))
        assertTrue(e.parseSuccess(shown).signatureValid)
    }

    @Test
    @DisplayName("[ts] numeric total_amount is verified against its raw JSON text (1000.0 stays 1000.0)")
    fun numericRawText() {
        val p = successData() // signed over total_amount=1000.0
        val json = Json.stringify(p).replace("\"total_amount\":\"1000.0\"", "\"total_amount\":1000.0")
        assertContains(json, "\"total_amount\":1000.0")
        assertTrue(e.parseSuccess(b64(json)).signatureValid)
    }

    @Test
    @DisplayName("[ts] verify: status API is authoritative and uses the stored total")
    fun verifyStatusApi() = suspendTest {
        mock.respond("""{"product_code":"EPAYTEST","transaction_uuid":"ORD-2","total_amount":1000,"status":"COMPLETE","ref_id":"0001TS9"}""")
        val p = successData()
        val v = e.verify(VerifyInput("ORD-2", 100000, callback = mapOf("data" to b64(Json.stringify(p)))))
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(100000, v.amountPaisa)
        assertEquals("0001TS9", v.transactionId)
        assertEquals(
            "https://rc.esewa.com.np/api/epay/transaction/status/?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2",
            mock.calls[0].url,
        )
    }

    @Test
    @DisplayName("[ts] verify: callback for another order is rejected")
    fun callbackOtherOrder() = suspendTest {
        val p = successData(mapOf("transaction_uuid" to "OTHER"))
        val err = assertFailsWith<PaymentException> {
            e.verify(VerifyInput("ORD-2", 100000, callback = mapOf("data" to b64(Json.stringify(p)))))
        }
        assertContains(err.message!!, "does not match")
    }

    @Test
    @DisplayName("[ts] status mapping")
    fun statusMapping() = suspendTest {
        for ((s, n) in listOf(
            "PENDING" to PaymentStatus.PENDING, "AMBIGUOUS" to PaymentStatus.PENDING, "NOT_FOUND" to PaymentStatus.NOT_FOUND,
            "FULL_REFUND" to PaymentStatus.REFUNDED, "CANCELED" to PaymentStatus.CANCELED, "WEIRD" to PaymentStatus.UNKNOWN,
        )) {
            mock.respond("""{"status":"$s","total_amount":10,"ref_id":null}""")
            assertEquals(n, e.verify(VerifyInput("X", 1000)).status)
        }
    }

    @Test
    @DisplayName("[py] numeric raw value with whitespace after the colon still verifies")
    fun numericRawWithSpaces() {
        val p = successData()
        val spaced = Json.stringify(p).replace("\":", "\": ").replace("\"total_amount\": \"1000.0\"", "\"total_amount\": 1000.0")
        assertContains(spaced, "\"total_amount\": 1000.0")
        assertTrue(e.parseSuccess(b64(spaced)).signatureValid)
    }

    @Test
    @DisplayName("[py] intent book signs the amount as a number and returns bookingId|correlationId")
    fun intentBook() = suspendTest {
        mock.respond("""{"code":"IP-201","data":{"booking_id":"VkQ=","deeplink":"https://rc-links.esewa.com.np/pay/VkQ=","correlation_id":"C1"}}""")
        val b = e.intentBook("txn-20251220-001", 10000, "https://cb", "https://done")
        val body = mock.calls[0].jsonBody()
        assertEquals("https://rc-checkout.esewa.com.np/api/client/intent/payment/book", mock.calls[0].url)
        assertEquals("oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=", body["signature"])
        assertEquals(BigDecimal("100"), body["amount"])
        assertContains(mock.calls[0].body!!, "\"amount\":100,")
        assertEquals("VkQ=|C1", b.providerRef)
        assertEquals("https://rc-links.esewa.com.np/pay/VkQ=", b.deeplink)
    }

    @Test
    @DisplayName("[kt] strict mode rejects a bad callback signature; lax mode falls through to the status API")
    fun strictSignature() = suspendTest {
        val forged = successData() + ("signature" to "AAAA")
        val cb = mapOf("data" to b64(Json.stringify(forged)))
        val err = assertFailsWith<PaymentException> { e.verify(VerifyInput("ORD-2", 100000, callback = cb)) }
        assertEquals("invalid_signature", err.code)
        val unsigned = b64(Json.stringify(successData() - "signature"))
        assertEquals("invalid_signature", assertFailsWith<PaymentException> { e.verify(VerifyInput("ORD-2", 100000, callback = mapOf("data" to unsigned))) }.code)

        val lax = Esewa(EsewaSandbox.config().copy(strictSignature = false), mock)
        mock.respond("""{"status":"PENDING","total_amount":1000.0,"ref_id":null}""")
        val v = lax.verify(VerifyInput("ORD-2", 100000, callback = cb))
        assertEquals(PaymentStatus.PENDING, v.status)
        assertEquals(false, (v.raw as Map<*, *>)["signatureValid"])
        assertEquals("malformed_callback", assertFailsWith<PaymentException> { e.verify(VerifyInput("ORD-2", 1, callback = mapOf("data" to "!!notbase64"))) }.code)
    }

    @Test
    @DisplayName("[kt] orderIdFromCallback: data payload, then orderId, order_id, transaction_uuid")
    fun orderIdFromCallback() {
        assertEquals("ORD-2", e.orderIdFromCallback(mapOf("data" to b64(Json.stringify(successData())), "orderId" to "X")))
        assertNull(e.orderIdFromCallback(mapOf("data" to "%%%", "orderId" to "X"))) // undecodable data: no fallback
        assertEquals("A", e.orderIdFromCallback(mapOf("orderId" to "A", "order_id" to "B", "transaction_uuid" to "C")))
        assertEquals("B", e.orderIdFromCallback(mapOf("order_id" to "B", "transaction_uuid" to "C")))
        assertEquals("C", e.orderIdFromCallback(mapOf("transaction_uuid" to "C")))
        assertNull(e.orderIdFromCallback(emptyMap()))
    }

    @Test
    @DisplayName("[kt] intent status/cancel/callback signing and transaction check")
    fun intentStatusCancelCallback() = suspendTest {
        mock.respond("""{"code":"IP-200","data":{"status":"BOOKED","transaction_id":"I1","reference_code":null}}""")
        val s = e.intentVerify("I1", "VkQ=|C1", 10000)
        assertEquals(PaymentStatus.PENDING, s.status)
        assertEquals(10000, s.amountPaisa)
        val body = mock.calls[0].jsonBody()
        assertEquals(esewaSign(EsewaSandbox.INTENT_ACCESS_KEY, mapOf("booking_id" to "VkQ=", "product_code" to "INTENT", "correlation_id" to "C1"), listOf("booking_id", "product_code", "correlation_id")), body["signature"])
        mock.respond("""{"data":{"status":"SUCCESS","transaction_id":"OTHER"}}""")
        assertEquals("callback_mismatch", assertFailsWith<PaymentException> { e.intentVerify("I1", "VkQ=|C1") }.code)
        mock.respond("""{"code":"IP-210","data":{"status":"CANCELED"}}""")
        assertEquals("CANCELED", e.intentCancel("VkQ=|C1").field("data").field("status"))
        assertEquals("booking_id,product_code", mock.calls[0].jsonBody()["signed_field_names"])

        val cb = linkedMapOf<String, Any?>("product_code" to "INTENT", "amount" to BigDecimal("100"), "reference_code" to "R", "status" to "SUCCESS")
        cb["signed_field_names"] = "product_code,amount,reference_code,status"
        cb["signature"] = esewaSign(EsewaSandbox.INTENT_ACCESS_KEY, cb, listOf("product_code", "amount", "reference_code", "status"))
        assertTrue(e.intentCallbackValid(cb))
        assertFalse(e.intentCallbackValid(cb + ("status" to "FAILED")))
        assertFalse(e.intentCallbackValid(cb - "signature"))
    }
}
