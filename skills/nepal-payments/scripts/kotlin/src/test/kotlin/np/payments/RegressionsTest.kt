package np.payments

import org.junit.jupiter.api.DisplayName
import java.security.KeyPairGenerator
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** TODO.md correctness list; mirrors the "regressions" block in scripts/ts/test/adapters.test.ts. */
class RegressionsTest {
    private val mock = MockTransport()
    private val e = Esewa(EsewaSandbox.config(), mock)

    @Test
    @DisplayName("[ts] paisaToRupees keeps the sign below one rupee")
    fun paisaSign() {
        assertEquals(listOf("-0.05", "-0.99", "-1", "-123.45"), listOf(-5L, -99L, -100L, -12345L).map(::paisaToRupees))
    }

    @Test
    @DisplayName("[ts] rupeesToPaisa rejects exponent and explicit plus forms")
    fun rupeesStrict() {
        for (bad in listOf("1e3", "+5", "NaN", "")) {
            assertContains(assertFailsWith<IllegalArgumentException> { rupeesToPaisa(bad) }.message!!, "not a rupee amount")
        }
    }

    @Test
    @DisplayName("[ts] basicAuth encodes UTF-8 credentials")
    fun basicAuthUtf8() {
        assertEquals("Basic " + toBase64("ü:पासवर्ड".toByteArray(Charsets.UTF_8)), basicAuth("ü", "पासवर्ड"))
    }

    @Test
    @DisplayName("[ts] newOrderId uses only the 36-symbol alphabet")
    fun orderIdAlphabet() {
        repeat(200) { assertTrue(Regex("^P[0-9A-Z]{18,19}$").matches(newOrderId())) }
    }

    @Test
    @DisplayName("[ts] provider lookup ignores Object.prototype keys")
    fun providerLookup() {
        val payments = Payments.create(PaymentsConfig(esewa = EsewaSandbox.config()), mock)
        for (id in listOf("constructor", "__proto__", "toString")) {
            assertContains(assertFailsWith<IllegalStateException> { payments.adapter(id) }.message!!, "not configured")
        }
        assertEquals(ProviderId.ESEWA, payments.adapter("esewa").id)
    }

    @Test
    @DisplayName("[ts] status tables ignore Object.prototype keys")
    fun statusTables() = suspendTest {
        for (s in listOf("constructor", "__proto__", "toString")) {
            mock.respond(mapOf("status" to s, "total_amount" to 10, "ref_id" to null))
            assertEquals(PaymentStatus.UNKNOWN, e.verify(VerifyInput("X", 1000)).status)
        }
    }

    @Test
    @DisplayName("[ts] eSewa: malformed success data is a 400, not a raw parse error")
    fun esewaMalformedData() = suspendTest {
        val notUtf8 = toBase64(byteArrayOf(0xff.toByte(), 0xfe.toByte()))
        for (data in listOf("!!!!", b64("not json"), b64("{"), notUtf8)) {
            val a = assertFailsWith<PaymentException> { e.parseSuccess(data) }
            assertEquals("malformed_callback" to 400, a.code to a.httpStatus)
            val b = assertFailsWith<PaymentException> { e.verify(VerifyInput("X", 1000, callback = mapOf("data" to data))) }
            assertEquals("malformed_callback" to 400, b.code to b.httpStatus)
        }
    }

    @Test
    @DisplayName("[ts] eSewa: error body read from error_message or errorMessage")
    fun esewaErrorBodies() = suspendTest {
        mock.respond(mapOf("code" to 0, "errorMessage" to "Service is currently unavailable"), 503)
        val a = assertFailsWith<PaymentException> { e.verify(VerifyInput("X", 1000)) }
        assertEquals("esewa_0" to 503, a.code to a.httpStatus)
        assertContains(a.message!!, "Service is currently unavailable")
        mock.respond(mapOf("code" to "IP-400", "error_message" to "Invalid Signature"), 400)
        val b = assertFailsWith<PaymentException> { e.intentBook("X", 10000, "https://c", "https://r") }
        assertEquals("esewa_IP-400" to 400, b.code to b.httpStatus)
        assertContains(b.message!!, "Invalid Signature")
        mock.respond("<html>bad gateway</html>", 502)
        val c = assertFailsWith<PaymentException> { e.verify(VerifyInput("X", 1000)) }
        assertEquals("http_502" to 502, c.code to c.httpStatus)
    }

    @Test
    @DisplayName("[py] eSewa orderIdFromCallback prefers orderId over order_id")
    fun esewaOrderIdKeyOrder() {
        assertEquals("A", e.orderIdFromCallback(mapOf("orderId" to "A", "order_id" to "B")))
    }

    @Test
    @DisplayName("[ts] eSewa Intent callback: raw body keeps number text; parsed body uses String(v)")
    fun intentCallbackFormats() {
        val key = EsewaSandbox.INTENT_ACCESS_KEY
        val order = listOf("product_code", "amount", "reference_code", "status")
        val names = order.joinToString(",")
        val base = mapOf("product_code" to "INTENT", "reference_code" to "R1", "status" to "SUCCESS")
        // Signed over "100.0", exactly as the JSON text carries it.
        val sigExact = esewaSign(key, base + ("amount" to "100.0"), order)
        val raw = """{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS","signed_field_names":"$names","signature":"$sigExact"}"""
        assertTrue(e.intentCallbackValid(raw))
        assertFalse(e.intentCallbackValid(Json.parse(raw).asJsonObject()!!)) // parsed: 100.0 is just 100
        // Signed over "100", the String(v) form; the raw body is accepted too.
        val sigJs = esewaSign(key, base + ("amount" to "100"), order)
        val raw2 = raw.replace(sigExact, sigJs)
        assertTrue(e.intentCallbackValid(raw2))
        assertTrue(e.intentCallbackValid(Json.parse(raw2).asJsonObject()!!))
        // null signs as "", tamper and junk fail.
        val sigNull = esewaSign(key, base + ("amount" to ""), order)
        assertTrue(e.intentCallbackValid(base + mapOf("amount" to null, "signed_field_names" to names, "signature" to sigNull)))
        assertFalse(e.intentCallbackValid(raw.replace("100.0", "1.0")))
        assertFalse(e.intentCallbackValid("not json"))
        assertFalse(e.intentCallbackValid("[1]"))
    }

    @Test
    @DisplayName("[ts] NPS: code 0 with null data is unknown, not a crash")
    fun npsNullData() = suspendTest {
        val n = Nps(NpsConfig(Environment.SANDBOX, "9", "M", "u", "p", "s"), mock)
        mock.respond("""{"code":"0","message":"","errors":[],"data":null}""")
        val v = n.verify(VerifyInput("T1", 10000))
        assertEquals(PaymentStatus.UNKNOWN, v.status)
        assertNull(v.amountPaisa)
    }

    @Test
    @DisplayName("[ts] connectIPS: txnAmt null is null, empty referenceId/remarks fall back")
    fun connectIpsFallbacks() = suspendTest {
        val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val c = ConnectIps(ConnectIpsConfig(Environment.SANDBOX, "550", "A", "T", "pw", kp.private), mock)
        mock.respond("""{"status":"ERROR","statusDesc":"TRANSACTION NOT FOUND","txnAmt":null}""")
        assertNull(c.verify(VerifyInput("T1", 500)).amountPaisa)
        val r = c.initiate(InitiateInput("T1", 500, "Shoes", ""), ConnectIpsInitiateExtras(referenceId = "", remarks = "")) as InitiateResult.Form
        assertEquals("T1", r.fields["REFERENCEID"])
        assertEquals("Shoes", r.fields["REMARKS"])
    }

    @Test
    @DisplayName("[ts] CyberSource: empty req_reference_number falls back to req_transaction_uuid")
    fun cyberSourceEmptyReference() = suspendTest {
        val cs = CyberSource(CyberSourceConfig(Environment.SANDBOX, "p", "a", "s"))
        val p = linkedMapOf(
            "decision" to "ACCEPT", "reason_code" to "100", "req_reference_number" to "", "req_transaction_uuid" to "T1",
            "req_amount" to "10.00", "req_currency" to "NPR", "transaction_id" to "X1",
        )
        p["signed_field_names"] = (p.keys + "signed_field_names").joinToString(",")
        p["signature"] = cybersourceSign("s", p)
        assertEquals(PaymentStatus.PAID, cs.verify(VerifyInput("T1", 1000, callback = p)).status)
    }
}
