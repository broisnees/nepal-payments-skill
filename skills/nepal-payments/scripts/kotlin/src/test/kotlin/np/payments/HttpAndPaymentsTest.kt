package np.payments

import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.DisplayName
import java.io.IOException
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class HttpTest {
    @Test
    @DisplayName("[kt] http: retries 5xx/429 and network errors for reads, then network_error; no retry by default")
    fun retries() = suspendTest {
        val mock = MockTransport()
        val http = Http(ProviderId.KHALTI, mock)
        mock.respond("busy", status = 503)
        assertEquals(503, http.request("https://x.test/a", retries = 2).status) // final attempt's response is returned
        assertEquals(3, mock.calls.size)
        mock.respond("x", status = 429)
        http.request("https://x.test/a", "POST", body = mapOf("a" to 1))
        assertEquals(1, mock.calls.size)

        mock.calls.clear()
        mock.handler = { throw IOException("connection reset") }
        val e = assertFailsWith<PaymentException> { http.request("https://x.test:8443/a", retries = 1) }
        assertEquals("network_error", e.code)
        assertEquals("request to x.test:8443 failed: connection reset", e.message)
        assertEquals(2, mock.calls.size)
    }

    @Test
    @DisplayName("[kt] http: default headers, JSON body, string body sent byte-for-byte, non-JSON kept as text")
    fun headersAndBodies() = suspendTest {
        val mock = MockTransport()
        val http = Http(ProviderId.FONEPAY, mock)
        mock.respond("<xml/>")
        val r = http.request("https://x.test", "POST", mapOf("accept" to "application/xml"), body = "{\"a\": 1}")
        assertEquals(mapOf("accept" to "application/xml", "Content-Type" to "application/json"), mock.calls[0].headers)
        assertEquals("{\"a\": 1}", mock.calls[0].body)
        assertEquals("<xml/>", r.data)
        mock.respond("")
        assertNull(http.request("https://x.test", headers = mapOf("content-type" to "text/plain"), body = "b").data)
        assertEquals(mapOf("Accept" to "application/json", "content-type" to "text/plain"), mock.calls[0].headers)
    }

    @Test
    @DisplayName("[kt] JdkHttpTransport: real exchange over loopback, and the timeout is enforced")
    fun jdkTransport() = suspendTest {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/echo") { ex ->
            val body = ex.requestBody.readBytes()
            val out = "{\"method\":\"${ex.requestMethod}\",\"auth\":\"${ex.requestHeaders.getFirst("auth")}\",\"len\":${body.size}}".toByteArray()
            ex.sendResponseHeaders(201, out.size.toLong())
            ex.responseBody.use { it.write(out) }
        }
        server.createContext("/slow") { ex ->
            Thread.sleep(1500)
            ex.sendResponseHeaders(200, -1)
            ex.close()
        }
        server.executor = java.util.concurrent.Executors.newCachedThreadPool()
        server.start()
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            val http = Http(ProviderId.NPS, JdkHttpTransport())
            val r = http.request("$base/echo", "POST", mapOf("auth" to "abc"), body = "{\"x\":\"é\"}", timeout = 5.seconds)
            assertEquals(201, r.status)
            assertEquals(mapOf("method" to "POST", "auth" to "abc", "len" to java.math.BigDecimal(10)), r.data)

            val started = System.nanoTime()
            val e = assertFailsWith<PaymentException> { http.request("$base/slow", timeout = 300.milliseconds) }
            assertEquals("network_error", e.code)
            assertContains(e.message!!, "timed out")
            assertTrue((System.nanoTime() - started) / 1_000_000 < 1400, "timeout not enforced")
        } finally {
            server.stop(0)
            (server.executor as java.util.concurrent.ExecutorService).shutdownNow()
        }
    }
}

class PaymentsTest {
    @Test
    @DisplayName("[kt] paymentsConfigFromEnv: same env names, enable rules, live/production modes")
    fun fromEnv() {
        val cfg = paymentsConfigFromEnv(
            mapOf(
                "ESEWA_PRODUCT_CODE" to "EPAYTEST", "ESEWA_SECRET_KEY" to "k", "ESEWA_ENV" to "live",
                "ESEWA_INTENT_PRODUCT_CODE" to "INTENT", "ESEWA_INTENT_ACCESS_KEY" to "a", "ESEWA_INTENT_BASE_URL" to "https://i",
                "KHALTI_SECRET_KEY" to "s", "KHALTI_WEBSITE_URL" to "", // half-configured: disabled
                "FONEPAY_MERCHANT_CODE" to "NBQM", "FONEPAY_SECRET_KEY" to "f", "FONEPAY_USERNAME" to "u",
                "NPS_MERCHANT_ID" to "9", "NPS_SECRET_KEY" to "n", "NPS_ENV" to "production",
                "IMEPAY_MERCHANT_CODE" to "MC", "IMEPAY_USERNAME" to "u",
                "CYBERSOURCE_PROFILE_ID" to "p", "CYBERSOURCE_ACCESS_KEY" to "a", "CYBERSOURCE_SECRET_KEY" to "s",
                "CONNECTIPS_MERCHANT_ID" to "550", "CONNECTIPS_APP_ID" to "A",
                "CONNECTIPS_PRIVATE_KEY_PEM" to "-----BEGIN PRIVATE KEY-----\\n" +
                    toBase64(java.security.KeyPairGenerator.getInstance("RSA").apply { initialize(1024) }.generateKeyPair().private.encoded) +
                    "\\n-----END PRIVATE KEY-----",
            ),
        )
        assertEquals(Environment.PRODUCTION, cfg.esewa!!.env)
        assertEquals(EsewaIntentCredentials("INTENT", "a", "https://i"), cfg.esewa.intent)
        assertNull(cfg.khalti)
        assertEquals("u", cfg.fonepay!!.username)
        assertEquals(Environment.SANDBOX, cfg.fonepay.env)
        assertEquals(Environment.PRODUCTION, cfg.nps!!.env)
        assertEquals("NPR", cfg.cybersource!!.currency)
        assertEquals("", cfg.imepay!!.password)
        assertEquals("550", cfg.connectips!!.merchantId)
        assertContains(cfg.esewa.toString(), "secretKey=***") // secrets never land in logs via toString

        val p = Payments.create(cfg, MockTransport())
        assertEquals(listOf(ProviderId.ESEWA, ProviderId.FONEPAY, ProviderId.CONNECTIPS, ProviderId.CYBERSOURCE, ProviderId.NPS, ProviderId.IMEPAY), p.enabled)
        assertEquals(ProviderId.FONEPAY, p.adapter("fonepay").id)
        assertEquals("NBQM", p.fonepay.config.merchantCode)
        assertContains(assertFailsWith<IllegalStateException> { p.khalti }.message!!, "\"khalti\" is not configured")
        assertFailsWith<IllegalStateException> { p.adapter("paypal") }
    }
}
