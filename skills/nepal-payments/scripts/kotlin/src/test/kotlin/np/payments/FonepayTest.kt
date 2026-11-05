package np.payments

import org.junit.jupiter.api.DisplayName
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FonepayTest {
    private val secret = "a7e3512f5032480a83137793cb2021dc" // public dev sample (spec v2.0)
    private val mock = MockTransport()
    private val dvFields = listOf("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT")

    private fun fp(env: Environment = Environment.SANDBOX, username: String? = null, password: String? = null, strict: Boolean = true) =
        Fonepay(FonepayConfig(env, "NBQM", secret, username, password, strictSignature = strict), mock)

    private fun signedCallback(vararg pairs: Pair<String, String>): Map<String, String> {
        val cb = linkedMapOf(*pairs)
        cb["DV"] = fonepayHmac(secret, dvFields.map { cb[it] ?: "" })
        return cb
    }

    @Test
    @DisplayName("[ts] response DV test vector (spec v2.0)")
    fun responseDv() {
        assertEquals(
            "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52",
            fonepayHmac(secret, listOf("d1580724437729", "NBQM", "true", "successful", "36463", "NICENPKA", "9841845631", "20.0", "30")),
        )
    }

    @Test
    @DisplayName("[ts] txnVerification `auth` header matches spec example byte-for-byte")
    fun txnVerificationAuth() = suspendTest {
        val f = fp(Environment.PRODUCTION, "gnw71090@zwoho.com", "Fonepay@12345")
        mock.respond("""{"paymentStatus":"success","prn":"d1549791827186","requestedAmount":"30","fonepayTraceId":12847}""")
        val v = f.verify(VerifyInput("d1549791827186", 3000))
        assertEquals("{\"prn\": \"d1549791827186\",\"merchantCode\": \"NBQM\",\"amount\": \"30\"}", mock.calls[0].body)
        assertEquals(
            "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2",
            mock.calls[0].header("auth"),
        )
        assertEquals("Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=", mock.calls[0].header("Authorization"))
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(3000, v.amountPaisa)
    }

    @Test
    @DisplayName("[ts] Dynamic QR dataValidation matches spec example")
    fun qrVector() = suspendTest {
        val f = fp(Environment.PRODUCTION, "u", "p")
        mock.respond("""{"qrMessage":"000201...","status":"CREATED","thirdpartyQrWebSocketUrl":"wss://localhost:8080/x"}""")
        val r = f.qrCreate("5d76d323-d1f6", 1400, "test1", "test2")
        assertEquals(
            "5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf",
            mock.calls[0].jsonBody()["dataValidation"],
        )
        assertEquals("wss://ws.fonepay.com/x", r.webSocketUrl) // localhost host rewritten
    }

    @Test
    @DisplayName("[ts] initiate: DV over raw values, PRN length enforced, Kathmandu date")
    fun initiate() = suspendTest {
        val f = fp()
        val r = f.initiate(InitiateInput("NP123", 1050, "Order 1", "https://s.example/r")) as InitiateResult.Redirect
        val q = queryParams(r.url)
        assertEquals("10.50", q["AMT"])
        assertTrue(Regex("^\\d{2}/\\d{2}/\\d{4}$").matches(q.getValue("DT")))
        assertEquals(fonepayHmac(secret, listOf("NBQM", "P", "NP123", "10.50", "NPR", q.getValue("DT"), "Order 1", "N/A", "https://s.example/r")), q["DV"])
        val err = assertFailsWith<PaymentException> { f.initiate(InitiateInput("X".repeat(26), 100, "x", "https://r")) }
        assertContains(err.message!!, "3–25")
        assertEquals("11/05/2026", fonepayDate(Instant.parse("2026-11-04T20:00:00Z"))) // already the 5th in Nepal (UTC+5:45)
    }

    @Test
    @DisplayName("[ts] forged callback without DV cannot force failed (legacy path)")
    fun forgedWithoutDv() = suspendTest {
        val forged = mapOf("PRN" to "NP123", "PID" to "NBQM", "PS" to "false", "RC" to "failed", "UID" to "x", "BC" to "y")
        assertEquals("invalid_signature", assertFailsWith<PaymentException> { fp().verify(VerifyInput("NP123", 1000, callback = forged)) }.code)
        val lax = fp(strict = false)
        assertEquals("verify_unavailable", assertFailsWith<PaymentException> { lax.verify(VerifyInput("NP123", 1000, callback = forged)) }.code)
    }

    @Test
    @DisplayName("[ts] legacy verification: upstream 5xx throws instead of reading as failed")
    fun legacy5xx() = suspendTest {
        val f = fp()
        val cb = signedCallback("PRN" to "NP123", "PID" to "NBQM", "PS" to "true", "RC" to "successful", "UID" to "36463", "BC" to "NICENPKA", "INI" to "98", "P_AMT" to "10", "R_AMT" to "10")
        mock.respond("<html>Bad Gateway</html>", status = 502)
        assertEquals("upstream_error", assertFailsWith<PaymentException> { f.verify(VerifyInput("NP123", 1000, callback = cb)) }.code)
        assertEquals(3, mock.calls.size) // read: 2 retries, then the final 502 is returned and rejected
        mock.respond("<response><response_code>successful</response_code><success>true</success></response>")
        val v = f.verify(VerifyInput("NP123", 1000, callback = cb))
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(1000, v.amountPaisa)
    }

    @Test
    @DisplayName("[ts] callback DV verified case-insensitively; tamper rejected")
    fun dvCaseInsensitive() {
        val f = fp()
        val cb = linkedMapOf(
            "PRN" to "d1580724437729", "PID" to "NBQM", "PS" to "true", "RC" to "successful", "UID" to "36463",
            "BC" to "NICENPKA", "INI" to "9841845631", "P_AMT" to "20.0", "R_AMT" to "30",
        )
        cb["DV"] = fonepayHmac(secret, cb.values.toList()).lowercase()
        assertTrue(f.callbackValid(cb))
        assertFalse(f.callbackValid(cb + ("R_AMT" to "3")))
    }

    @Test
    @DisplayName("[kt] PRN >= 3 and RU <= 150 enforced")
    fun limits() = suspendTest {
        assertEquals("invalid_order_id", assertFailsWith<PaymentException> { fp().initiate(InitiateInput("AB", 100, "x", "https://r")) }.code)
        val ru = "https://s.example/" + "r".repeat(133)
        assertEquals(151, ru.length)
        assertEquals("invalid_return_url", assertFailsWith<PaymentException> { fp().initiate(InitiateInput("ABC", 100, "x", ru)) }.code)
        fp().initiate(InitiateInput("A".repeat(25), 100, "x", ru.dropLast(1)))
    }

    @Test
    @DisplayName("[kt] legacy verification: unparseable 200 throws; DV-signed negative is final; mismatched PRN rejected")
    fun legacyEdges() = suspendTest {
        val f = fp()
        val ok = signedCallback("PRN" to "NP123", "PID" to "NBQM", "PS" to "true", "RC" to "successful", "UID" to "1", "BC" to "B", "INI" to "9", "P_AMT" to "10", "R_AMT" to "10")
        mock.respond("<html>WAF</html>")
        assertEquals("malformed_response", assertFailsWith<PaymentException> { f.verify(VerifyInput("NP123", 1000, callback = ok)) }.code)

        mock.respond("unused")
        val canceled = signedCallback("PRN" to "NP123", "PID" to "NBQM", "PS" to "false", "RC" to "cancel", "UID" to "1", "BC" to "B")
        assertEquals(PaymentStatus.CANCELED, f.verify(VerifyInput("NP123", 1000, callback = canceled)).status)
        assertEquals(0, mock.calls.size)

        val other = signedCallback("PRN" to "OTHER", "PID" to "NBQM", "PS" to "true", "RC" to "successful", "UID" to "1", "BC" to "B")
        assertEquals("callback_mismatch", assertFailsWith<PaymentException> { f.verify(VerifyInput("NP123", 1000, callback = other)) }.code)
        assertEquals("NP123", f.orderIdFromCallback(ok))
    }

    @Test
    @DisplayName("[kt] QR status maps paymentStatus and keeps the stored amount")
    fun qrStatus() = suspendTest {
        mock.respond("""{"paymentStatus":"success","fonepayTraceId":991}""")
        val v = fp(username = "u", password = "p").qrStatus("5d76d323-d1f6", 1400)
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(1400, v.amountPaisa)
        assertEquals("991", v.transactionId)
        assertEquals("https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/thirdPartyDynamicQrGetStatus", mock.calls[0].url)
    }
}
