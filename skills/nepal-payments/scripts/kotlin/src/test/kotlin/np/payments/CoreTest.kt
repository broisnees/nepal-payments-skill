package np.payments

import org.junit.jupiter.api.DisplayName
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes

class CoreTest {
    @Test
    @DisplayName("[ts] money conversions are exact")
    fun money() {
        assertEquals("100", paisaToRupees(10000))
        assertEquals("100.50", paisaToRupees(10050))
        assertEquals("0.05", paisaToRupees(5))
        assertEquals(100000, rupeesToPaisa("1,000.0"))
        assertEquals(10010, rupeesToPaisa(100.1))
        assertEquals(10, rupeesToPaisa("0.1"))
        assertEquals(2000, rupeesToPaisa("19.995"))
        assertEquals(101, rupeesToPaisa(1.005)) // same as Python Decimal(str(x)); binary rounding would give 100
    }

    @Test
    @DisplayName("[ts] decideTransition: the state machine")
    fun stateMachine() {
        val zero = 0.milliseconds
        assertEquals(PaymentStatus.PAID, decideTransition(AttemptStatus.Initiated, PaymentStatus.PAID, 1000, 1000, zero).next)
        // amount guard: mismatch and missing amount both go to review, never paid
        assertEquals(
            TransitionDecision(PaymentStatus.UNKNOWN, reviewRequired = true, latePaid = false, reason = "amount mismatch: stored 1000, provider 10"),
            decideTransition(PaymentStatus.PENDING, PaymentStatus.PAID, 10, 1000, zero),
        )
        assertTrue(decideTransition(PaymentStatus.PENDING, PaymentStatus.PAID, null, 1000, zero).reviewRequired)
        // not_found keeps the attempt open inside the window, expires after
        assertNull(decideTransition(AttemptStatus.Initiated, PaymentStatus.NOT_FOUND, null, 1000, 5.minutes).next)
        assertEquals(PaymentStatus.EXPIRED, decideTransition(AttemptStatus.Initiated, PaymentStatus.NOT_FOUND, null, 1000, 2.hours).next)
        // late payment after we closed it is recovered, not dropped
        val late = decideTransition(PaymentStatus.EXPIRED, PaymentStatus.PAID, 1000, 1000, 3.hours)
        assertEquals(PaymentStatus.PAID, late.next)
        assertTrue(late.latePaid)
        // paid is terminal for automation; same status is a no-op
        assertNull(decideTransition(PaymentStatus.PAID, PaymentStatus.FAILED, null, 1000, zero).next)
        assertNull(decideTransition(PaymentStatus.PENDING, PaymentStatus.PENDING, null, 1000, zero).next)
        assertNull(decideTransition(PaymentStatus.FAILED, PaymentStatus.CANCELED, null, 1000, zero).next)
    }

    @Test
    @DisplayName("[ts] base64 tolerates '+' turned into space")
    fun base64Space() {
        val b = toBase64(byteArrayOf(251.toByte(), 255.toByte(), 190.toByte()))
        assertEquals("+/++", b)
        assertContentEquals(byteArrayOf(251.toByte(), 255.toByte(), 190.toByte()), fromBase64(b.replace('+', ' ')))
    }

    @Test
    @DisplayName("[ts] newOrderId fits every provider")
    fun orderIds() {
        repeat(1000) { assertTrue(Regex("^[A-Z0-9]{17,20}$").matches(newOrderId())) }
    }

    @Test
    @DisplayName("[ts] auto-submit form escapes values")
    fun formEscapes() {
        val html = renderAutoSubmitForm(InitiateResult.Form("https://x/pay", mapOf("a" to "\"><script>")))
        assertContains(html, "&quot;&gt;&lt;script&gt;")
    }

    @Test
    @DisplayName("[py] base64 space restore keeps a LEADING '+' (spaces -> '+' before trim)")
    fun base64LeadingPlus() {
        assertContentEquals(byteArrayOf(251.toByte(), 255.toByte(), 190.toByte()), fromBase64(" /  "))
    }

    @Test
    @DisplayName("[py] auto-submit form carries enctype")
    fun formEnctype() {
        val html = renderAutoSubmitForm(InitiateResult.Form("https://x", mapOf("a" to "\"><script>"), enctype = InitiateResult.MULTIPART))
        assertContains(html, "&quot;&gt;&lt;script&gt;")
        assertContains(html, "enctype=\"multipart/form-data\"")
    }

    @Test
    @DisplayName("[kt] decideTransition: late paid with wrong amount -> unknown + review; constants")
    fun latePaidMismatch() {
        val d = decideTransition(PaymentStatus.FAILED, PaymentStatus.PAID, 5, 1000, 3.hours)
        assertEquals(TransitionDecision(PaymentStatus.UNKNOWN, reviewRequired = true, latePaid = true, reason = "amount mismatch: stored 1000, provider 5"), d)
        val v = VerifyResult(ProviderId.KHALTI, PaymentStatus.PAID, "O", 1000, "T", null)
        assertEquals(PaymentStatus.PAID, decideTransition(PaymentStatus.UNKNOWN, v, 1000, 0.milliseconds).next)
        assertEquals(listOf("initiated", "pending", "unknown"), OPEN_STATUSES.map { it.wire })
        assertEquals(AttemptStatus.Initiated, AttemptStatus.fromWire("initiated"))
        assertEquals(PaymentStatus.PARTIALLY_REFUNDED, AttemptStatus.fromWire("partially_refunded"))
    }

    @Test
    @DisplayName("[kt] rupeesToPaisa rejects what the TS regex rejects; paisaToRupees keeps the sign")
    fun moneyEdges() {
        for (bad in listOf("1e5", "+5", ".5", "5.", "abc", "")) assertFailsWith<IllegalArgumentException> { rupeesToPaisa(bad) }
        assertFailsWith<IllegalArgumentException> { rupeesToPaisa(Double.NaN) }
        assertFailsWith<IllegalArgumentException> { rupeesToPaisa(java.math.BigDecimal("1e999999999")) }
        assertEquals(-101, rupeesToPaisa("-1.005"))
        assertEquals(110000, rupeesToPaisa(java.math.BigDecimal("1100.0")))
        assertEquals("-0.05", paisaToRupees(-5))
        assertEquals("-1.05", paisaToRupees(-105))
        assertFailsWith<PaymentException> { assertPaisa(0, ProviderId.ESEWA) }
        assertFailsWith<PaymentException> { assertPaisa(MAX_SAFE_PAISA + 1, ProviderId.ESEWA) }
    }

    @Test
    @DisplayName("[kt] crypto helpers: constant-time compare, hex, basic auth")
    fun cryptoHelpers() {
        assertTrue(safeEqual("abc", "abc"))
        assertFalse(safeEqual("abc", "abd"))
        assertFalse(safeEqual("abc", "abcd"))
        assertEquals("00ff10", toHex(byteArrayOf(0, -1, 16)))
        assertEquals("Basic dTpw", basicAuth("u", "p"))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", toHex(sha256("abc")))
        assertEquals("a&amp;b&lt;c&gt;d&quot;e&#39;", escapeHtml("a&b<c>d\"e'"))
    }
}
