package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class KhaltiTest {
    private val mock = MockTransport()
    private val k = Khalti(KhaltiConfig("live_secret_key_test", Environment.SANDBOX, "https://shop.example"), mock)

    private fun lookup(status: String, txn: String? = "T") =
        """{"pidx":"P","total_amount":1000,"status":"$status","transaction_id":${if (txn == null) "null" else "\"$txn\""},"fee":0,"refunded":false}"""

    @Test
    @DisplayName("[ts] initiate: integer paisa, trailing slash, Key header")
    fun initiate() = suspendTest {
        mock.respond("""{"pidx":"PIDX1","payment_url":"https://test-pay.khalti.com/?pidx=PIDX1","expires_at":"x","expires_in":1800}""")
        val r = k.initiate(InitiateInput("O1", 1000, "Book", "https://shop.example/r"))
        assertEquals("https://dev.khalti.com/api/v2/epayment/initiate/", mock.calls[0].url)
        assertEquals("Key live_secret_key_test", mock.calls[0].header("Authorization"))
        assertEquals(BigDecimal(1000), mock.calls[0].jsonBody()["amount"])
        assertEquals("PIDX1", (r as InitiateResult.Redirect).providerRef)
    }

    @Test
    @DisplayName("[ts] minimum Rs 10")
    fun minimum() = suspendTest {
        val err = assertFailsWith<PaymentException> { k.initiate(InitiateInput("O", 999, "x", "https://r")) }
        assertContains(err.message!!, "minimum")
    }

    @Test
    @DisplayName("[ts] lookup: Expired arrives as HTTP 400 with a normal body")
    fun expired400() = suspendTest {
        mock.respond(lookup("Expired", null), status = 400)
        assertEquals(PaymentStatus.EXPIRED, k.verify(VerifyInput("O", 1000, providerRef = "P")).status)
    }

    @Test
    @DisplayName("[ts] lookup: Completed / User canceled / Partially Refunded")
    fun lookupMapping() = suspendTest {
        for ((s, n) in listOf(
            "Completed" to PaymentStatus.PAID, "User canceled" to PaymentStatus.CANCELED,
            "Partially refunded" to PaymentStatus.PARTIALLY_REFUNDED, "Initiated" to PaymentStatus.PENDING,
        )) {
            mock.respond(lookup(s))
            assertEquals(n, k.verify(VerifyInput("O", 1000, providerRef = "P")).status)
        }
    }

    @Test
    @DisplayName("[ts] refuses callback pidx that differs from the stored one (replay guard)")
    fun replayGuard() = suspendTest {
        val err = assertFailsWith<PaymentException> {
            k.verify(VerifyInput("O", 1000, providerRef = "P", callback = mapOf("pidx" to "OTHER")))
        }
        assertContains(err.message!!, "does not match")
    }

    @Test
    @DisplayName("[ts] 401 surfaces as unauthorized")
    fun unauthorized() = suspendTest {
        mock.respond("""{"detail":"Invalid token.","status_code":401}""", status = 401)
        assertEquals("unauthorized", assertFailsWith<PaymentException> { k.verify(VerifyInput("O", 1000, providerRef = "P")) }.code)
    }

    @Test
    @DisplayName("[py] lookup: User canceled arrives as HTTP 400 too")
    fun userCanceled400() = suspendTest {
        mock.respond(lookup("User canceled"), status = 400)
        assertEquals(PaymentStatus.CANCELED, k.verify(VerifyInput("O", 1000, providerRef = "P")).status)
    }

    @Test
    @DisplayName("[kt] verify sends the STORED pidx to lookup/ (trailing slash); amount + txn id; 404 -> not_found")
    fun lookupRequest() = suspendTest {
        mock.respond(lookup("Completed"))
        val v = k.verify(VerifyInput("O", 1000, providerRef = "P", callback = mapOf("pidx" to "P", "purchase_order_id" to "O")))
        assertEquals("https://dev.khalti.com/api/v2/epayment/lookup/", mock.calls[0].url)
        assertEquals("P", mock.calls[0].jsonBody()["pidx"])
        assertEquals(1000, v.amountPaisa)
        assertEquals("T", v.transactionId)
        assertEquals("O", k.orderIdFromCallback(mapOf("purchase_order_id" to "O")))
        mock.respond("""{"detail":"Not found."}""", status = 404)
        assertEquals(PaymentStatus.NOT_FOUND, k.verify(VerifyInput("O", 1000, providerRef = "P")).status)
        assertEquals("missing_pidx", assertFailsWith<PaymentException> { k.verify(VerifyInput("O", 1000)) }.code)
    }

    @Test
    @DisplayName("[kt] refund URL is encoded and keeps the trailing slash")
    fun refund() = suspendTest {
        mock.respond("""{"detail":"Transaction refund successful."}""")
        k.refund("abc/1", amountPaisa = 500, mobile = "9800000000")
        assertEquals("https://dev.khalti.com/api/merchant-transaction/abc%2F1/refund/", mock.calls[0].url)
        assertEquals(BigDecimal(500), mock.calls[0].jsonBody()["amount"])
    }
}
