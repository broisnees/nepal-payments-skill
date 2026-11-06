package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HamroPayTest {
    private val mock = MockTransport()
    private val cfg = HamroPayConfig(
        env = Environment.SANDBOX,
        merchantId = "PN_-Nd99TBnAlBjCgl8ef_b",
        clientId = "client@123",
        clientApiKey = "merchant-api-key-test",
        clientSecret = "abcdefg",
        webhookSecret = "whsec",
    )
    private val h = HamroPay(cfg, mock)
    private val m = cfg.merchantId

    private fun node(secret: String, msg: String): String = Base64.getEncoder().encodeToString(
        Mac.getInstance("HmacSHA512").run {
            init(SecretKeySpec(secret.toByteArray(), "HmacSHA512"))
            doFinal(msg.toByteArray())
        },
    )

    private fun input(orderId: String = "P1", amountPaisa: Long = 1000) = InitiateInput(orderId, amountPaisa, "x", "https://a/")

    @Test
    @DisplayName("[ts] signature: base64 HMAC-SHA512 over comma-joined values; commas refused")
    fun sign() {
        assertEquals(node("abcdefg", "T1,1000,M,C,K"), hamroPaySign("abcdefg", listOf("T1", "1000", "M", "C", "K")))
        assertContains(assertFailsWith<IllegalArgumentException> { hamroPaySign("s", listOf("a,b")) }.message!!, "commas")
    }

    @Test
    @DisplayName("[ts] initiate: Create Session signed in headers, then a signed gateway form")
    fun initiate() = suspendTest {
        mock.respond(mapOf("sessionId" to "ca8f7b70-b9c9-11ee-8611-0a73743c8233", "merchantId" to m))
        val r = h.initiate(InitiateInput("P1", 8992, "T-shirt", "https://shop.example/ok", failureUrl = "https://shop.example/no"))
        val call = mock.calls[0]
        assertEquals("https://uat-payclient.hamropatro.com/v1/checkout/sessionId", call.url)
        assertEquals("client@123", call.header("Client-Id"))
        assertEquals("merchant-api-key-test", call.header("Client-API-Key"))
        assertEquals("close", call.header("Connection"))
        assertEquals(node("abcdefg", "P1,8992,$m,client@123,merchant-api-key-test"), call.header("Signature"))
        val body = call.jsonBody()
        val product = (body["productList"] as List<*>)[0].asJsonObject()!!
        assertEquals(
            listOf("P1", "8992", "https://shop.example/ok", "https://shop.example/no", BigDecimal("89.92")),
            listOf(body["merchantTxnId"], body["transactionAmount"], body["successRedirectionUrl"], body["failedRedirectionUrl"], product["price"]),
        )
        r as InitiateResult.Form
        assertEquals("https://uat-checkout-pay.hamropatro.com/api/checkout", r.action)
        assertEquals("ca8f7b70-b9c9-11ee-8611-0a73743c8233", r.providerRef)
        assertEquals(node("abcdefg", "$m,P1,ca8f7b70-b9c9-11ee-8611-0a73743c8233,8992,client@123,merchant-api-key-test"), r.fields["token"])
        assertEquals(listOf("merchant_id", "session_id", "token", "merchant_transaction_id", "remarks"), r.fields.keys.toList())
    }

    @Test
    @DisplayName("[ts] initiate: Rs 10..50,000, 25-char id, live gateway required, merchant echo checked")
    fun initiateLimits() = suspendTest {
        assertContains(assertFailsWith<PaymentException> { h.initiate(input(amountPaisa = 999)) }.message!!, "Rs 10")
        assertContains(assertFailsWith<PaymentException> { h.initiate(input(amountPaisa = 5_000_001)) }.message!!, "Rs 10")
        assertContains(assertFailsWith<PaymentException> { h.initiate(input(orderId = "X".repeat(26))) }.message!!, "1–25")
        val live = HamroPay(cfg.copy(env = Environment.PRODUCTION), mock)
        assertContains(assertFailsWith<IllegalStateException> { live.initiate(input()) }.message!!, "gatewayUrl")
        mock.respond(mapOf("sessionId" to "S", "merchantId" to "SOMEONE_ELSE"))
        assertEquals("merchant_mismatch", assertFailsWith<PaymentException> { h.initiate(input()) }.code)
        mock.respond(mapOf("code" to 16, "message" to "Unauthorized Request", "details" to emptyList<Any>()), status = 401)
        assertEquals("unauthorized", assertFailsWith<PaymentException> { h.initiate(input()) }.code)
    }

    @Test
    @DisplayName("[ts] verify: Get Transaction signed, status mapping, rupees to paisa, id echo checked")
    fun verify() = suspendTest {
        val cases: List<Triple<Map<String, Any?>, PaymentStatus, Long?>> = listOf(
            Triple(mapOf("merchantTxnId" to "P1", "status" to "COMPLETED", "amount" to 89.92, "trackingId" to "TRK1"), PaymentStatus.PAID, 8992L),
            Triple(mapOf("merchantTransactionId" to "P1", "status" to "PROCESSING", "amount" to 0), PaymentStatus.PENDING, null),
            Triple(mapOf("merchantTxnId" to "P1", "status" to "FAILED", "amount" to 0), PaymentStatus.FAILED, null),
            Triple(
                mapOf("merchantTransactionId" to "P1", "trackingId" to "", "status" to "NOT_INITIATED", "amount" to 0, "message" to "TRANSACTION NOT INITIATED YET"),
                PaymentStatus.NOT_FOUND, null,
            ),
            Triple(mapOf("merchantTxnId" to "P1", "status" to "SOMETHING_NEW"), PaymentStatus.UNKNOWN, null),
        )
        for ((body, want, amt) in cases) {
            mock.respond(body)
            val v = h.verify(VerifyInput("P1", 8992))
            assertEquals(want to amt, v.status to v.amountPaisa)
            assertEquals("https://uat-payclient.hamropatro.com/v1/checkout/transaction", mock.calls[0].url)
            assertEquals(node("abcdefg", "P1,$m,client@123,merchant-api-key-test"), mock.calls[0].header("Signature"))
            assertEquals(mapOf("merchantId" to m, "merchantTxnId" to "P1"), mock.calls[0].jsonBody())
        }
        mock.respond(mapOf("merchantTxnId" to "P2", "status" to "COMPLETED", "amount" to 89.92))
        assertEquals("id_mismatch", assertFailsWith<PaymentException> { h.verify(VerifyInput("P1", 8992)) }.code)
        assertEquals("P1", h.orderIdFromCallback(mapOf("MerchantTxnId" to "P1")))
    }

    @Test
    @DisplayName("[ts] webhook: signature over merchantTxnId,merchantId,status,amount in any rendering of the amount")
    fun webhook() {
        val body = mapOf("merchantTxnId" to "P1", "merchantId" to m, "amount" to 1200, "status" to "COMPLETED", "metadata" to emptyMap<String, Any?>())
        for (a in listOf("1200", "1200.0", "1200.00")) {
            assertTrue(h.verifyWebhook(body, node("whsec", "P1,$m,COMPLETED,$a")), a)
        }
        assertTrue(h.verifyWebhook(body + ("amount" to 1.5), node("whsec", "P1,$m,COMPLETED,1.50")))
        assertFalse(h.verifyWebhook(body + ("amount" to 1201), node("whsec", "P1,$m,COMPLETED,1200")))
        assertFalse(h.verifyWebhook(body + ("amount" to "1200"), node("whsec", "P1,$m,COMPLETED,1200")))
        assertFalse(h.verifyWebhook(body, null))
        val noSecret = HamroPay(cfg.copy(webhookSecret = null), mock)
        assertContains(assertFailsWith<IllegalStateException> { noSecret.verifyWebhook(body, "x") }.message!!, "webhookSecret")
    }

    @Test
    @DisplayName("[kt] JdkHttpTransport: Connection: close gets a fresh connection each call; other requests reuse")
    fun jdkConnectionClose() = suspendTest {
        val ports = java.util.Collections.synchronizedList(mutableListOf<Int>())
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            ex.requestBody.readBytes()
            ports += ex.remoteAddress.port
            val out = """{"merchantTxnId":"P1","status":"PENDING"}""".toByteArray()
            ex.sendResponseHeaders(200, out.size.toLong())
            ex.responseBody.use { it.write(out) }
        }
        server.start()
        try {
            val url = "http://127.0.0.1:${server.address.port}"
            val transport = JdkHttpTransport(java.net.http.HttpClient.newBuilder().version(java.net.http.HttpClient.Version.HTTP_1_1).build())
            val live = HamroPay(cfg.copy(apiBaseUrl = "$url/"), transport)
            assertEquals(PaymentStatus.PENDING, live.verify(VerifyInput("P1", 1000)).status)
            assertEquals(PaymentStatus.PENDING, live.verify(VerifyInput("P1", 1000)).status)
            assertEquals(2, ports.toSet().size, "Connection: close must not reuse a pooled socket: $ports")

            ports.clear()
            val http = Http(ProviderId.KHALTI, transport)
            repeat(2) { assertEquals(200, http.request("$url/plain").status) }
            assertEquals(1, ports.toSet().size, "ordinary requests should reuse the keep-alive socket: $ports")
        } finally {
            server.stop(0)
            (server.executor as? java.util.concurrent.ExecutorService)?.shutdownNow()
        }
    }

    /** Loopback server that answers each connection with a chunked body whose terminating chunk never comes. */
    private fun truncatingServer(status: Int, body: String): java.net.ServerSocket {
        val ss = java.net.ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress())
        Thread {
            while (!ss.isClosed) {
                runCatching {
                    ss.accept().use { c ->
                        c.getInputStream().read(ByteArray(8192))
                        val b = body.toByteArray()
                        val head = "HTTP/1.1 $status X\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n" +
                            "Transfer-Encoding: chunked\r\n\r\n${Integer.toHexString(b.size)}\r\n"
                        c.getOutputStream().apply { write(head.toByteArray()); write(b); write("\r\n".toByteArray()); flush() }
                    }
                }
            }
        }.apply { isDaemon = true }.start()
        return ss
    }

    @Test
    @DisplayName("[kt] JdkHttpTransport: a truncated chunked body is kept when it is complete JSON, else network_error")
    fun jdkTruncatedBody() = suspendTest {
        truncatingServer(401, """{"code":16,"message":"Unauthorized Request","details":[]}""").use { ss ->
            val live = HamroPay(cfg.copy(apiBaseUrl = "http://127.0.0.1:${ss.localPort}"), JdkHttpTransport())
            val e = assertFailsWith<PaymentException> { live.verify(VerifyInput("P1", 1000)) }
            assertEquals("unauthorized", e.code)
            assertEquals(401, e.httpStatus)
        }
        truncatingServer(401, """{"code":16,"mess""").use { ss ->
            val live = HamroPay(cfg.copy(apiBaseUrl = "http://127.0.0.1:${ss.localPort}"), JdkHttpTransport())
            assertEquals("network_error", assertFailsWith<PaymentException> { live.verify(VerifyInput("P1", 1000)) }.code)
        }
    }

    @Test
    @DisplayName("[kt] webhook: parsed JSON body (BigDecimal amount) verifies; env config and registration")
    fun webhookParsedAndEnv() {
        val raw = """{"merchantTxnId":"P1","merchantId":"$m","amount":1200.00,"status":"COMPLETED","metadata":{}}"""
        assertTrue(h.verifyWebhook(Json.parse(raw).asJsonObject()!!, node("whsec", "P1,$m,COMPLETED,1200.0")))
        val env = mapOf(
            "HAMROPAY_MERCHANT_ID" to "M", "HAMROPAY_CLIENT_ID" to "C", "HAMROPAY_CLIENT_API_KEY" to "K", "HAMROPAY_CLIENT_SECRET" to "S",
            "HAMROPAY_ENV" to "production", "HAMROPAY_GATEWAY_URL" to "https://live.example/api/checkout",
            "GETPAY_PAP_INFO" to "cGFw", "GETPAY_OPR_KEY" to "k", "GETPAY_WEBSITE_DOMAIN" to "https://shop.example",
        )
        val c = paymentsConfigFromEnv(env)
        assertEquals(Environment.PRODUCTION, c.hamropay!!.env)
        assertEquals("https://live.example/api/checkout", c.hamropay.gatewayUrl)
        assertEquals("NPR", c.getpay!!.currency)
        assertEquals("", c.getpay.businessName)
        assertContains(c.hamropay.toString(), "clientSecret=***")
        val p = Payments.create(c, mock)
        assertEquals(listOf(ProviderId.HAMROPAY, ProviderId.GETPAY), p.enabled)
        assertEquals(ProviderId.GETPAY, p.adapter("getpay").id)
        assertEquals("M", p.hamropay.config.merchantId)
        assertNull(paymentsConfigFromEnv(env - "HAMROPAY_CLIENT_SECRET").hamropay)
    }
}

class GetPayTest {
    private val mock = MockTransport()
    private val cfg = GetPayConfig(
        env = Environment.SANDBOX,
        papInfo = b64("""{"institutionId":"122","mid":"123123451770986","tid":"12358762"}"""),
        oprKey = "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5",
        websiteDomain = "https://shop.example",
        businessName = "Shop",
        imageUrl = "https://shop.example/logo.png",
    )
    private val g = GetPay(cfg, mock)
    private val base = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
    private val id = "0cc5b1a39f3c4cad864bc1c6a524534f"
    private val secret = toBase64(MessageDigest.getInstance("SHA-256").digest((cfg.oprKey + id).toByteArray()))
    private val token = b64("""{"id":"$id","oprSecret":"$secret"}""")

    private fun ok(vararg data: Pair<String, Any?>) = mock.respond(mapOf("status" to 0, "message" to "SUCCESS", "data" to linkedMapOf(*data)))

    @Test
    @DisplayName("[ts] oprSecret = base64(SHA-256(oprKey + id)); token decodes from JSON or id:secret")
    fun token() {
        assertEquals(secret, getPayOprSecret(cfg.oprKey, id))
        assertEquals(GetPayToken(id, secret), getPayDecodeToken(token))
        assertEquals(GetPayToken(id, secret), getPayDecodeToken(b64("$id:$secret")))
        assertNull(getPayDecodeToken("%%%"))
        assertNull(getPayDecodeToken(b64("""{"id":"$id"}""")))
    }

    @Test
    @DisplayName("[ts] initiate: SDK options with a numeric price, clientRequestId and same-origin callbacks")
    fun initiate() = suspendTest {
        val r = g.initiate(InitiateInput("P1", 120050, "Cup <set>", "https://shop.example/ok/P1", failureUrl = "https://shop.example/no/P1"))
        r as InitiateResult.Sdk
        assertEquals("https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js", r.scriptUrl)
        assertEquals(BigDecimal("1200.5"), r.options["price"])
        assertEquals("P1", r.options["clientRequestId"])
        assertEquals(base, r.options["baseUrl"])
        assertEquals("", r.options["insKey"])
        assertEquals(mapOf("successUrl" to "https://shop.example/ok/P1", "failUrl" to "https://shop.example/no/P1"), r.options["callbackUrl"])
        assertContains(r.options["orderInformationUI"] as String, "Cup &lt;set&gt;")
        val e = assertFailsWith<PaymentException> { g.initiate(InitiateInput("P1", 100, "x", "https://evil.example/ok")) }
        assertEquals("invalid_callback_url", e.code)
        val page = g.checkoutPage(r, "/pay/P1</script>")
        assertContains(page, "new GetPay(o).initialize()")
        assertTrue(!page.contains("</script>\"") && page.contains("\\u003c/script>"))
        assertContains(page, "\"price\":1200.5")
        assertContains(g.paymentPage(), "<div id=\"checkout\"></div>")
        assertContains(g.returnPage("/payments/getpay/return/P1"), "window.top.location")
    }

    @Test
    @DisplayName("[ts] verify with token: oprSecret checked, merchant-status, clientId must be this order")
    fun verifyToken() = suspendTest {
        ok("status" to "SUCCESS", "amount" to 1200.0, "currency" to "NPR", "stan" to "379832", "crrn" to "624503379832", "clientId" to "P1", "remarks" to "Success")
        val v = g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to token)))
        assertEquals(Triple(PaymentStatus.PAID, 120000L, id), Triple(v.status, v.amountPaisa, v.transactionId))
        assertEquals("$base/merchant-status", mock.calls[0].url)
        assertEquals(mapOf("id" to id, "papInfo" to cfg.papInfo), mock.calls[0].jsonBody())

        ok("status" to "SUCCESS", "amount" to 1200.0, "clientId" to "SOMEONE-ELSES-ORDER")
        assertEquals("id_mismatch", assertFailsWith<PaymentException> { g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to token))) }.code)

        val forged = b64("""{"id":"$id","oprSecret":"${b64("not the hash")}"}""")
        assertEquals("bad_signature", assertFailsWith<PaymentException> { g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to forged))) }.code)
        assertEquals("malformed_callback", assertFailsWith<PaymentException> { g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to "@@"))) }.code)

        ok("status" to "FAILED", "amount" to 1200.0, "clientId" to "P1")
        assertEquals(PaymentStatus.FAILED, g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to token))).status)
        mock.respond(mapOf("status" to -1, "message" to "Failed to fetch merchant information: Transaction not found for ID: $id"), status = 400)
        assertEquals(PaymentStatus.NOT_FOUND, g.verify(VerifyInput("P1", 120000, callback = mapOf("token" to token))).status)
    }

    @Test
    @DisplayName("[ts] verify without token: statement by clientRequestId; a success there is unknown, never paid")
    fun verifyStatement() = suspendTest {
        ok("transactionId" to id, "clientRequestId" to "P1", "saleTransactionAmount" to 1200.0, "status" to "SUCCESS", "paymentScheme" to "MASTERCARD")
        val v = g.verify(VerifyInput("P1", 120000))
        assertEquals(Triple(PaymentStatus.UNKNOWN, 120000L, id), Triple(v.status, v.amountPaisa, v.transactionId))
        assertEquals("$base/transaction-statement", mock.calls[0].url)
        assertEquals(mapOf("clientRequestId" to "P1"), mock.calls[0].jsonBody())
        ok("transactionId" to id, "clientRequestId" to "P1", "saleTransactionAmount" to 1200.0, "status" to "FAILED")
        assertEquals(PaymentStatus.FAILED, g.verify(VerifyInput("P1", 120000)).status)
        mock.respond(mapOf("status" to -1, "message" to "Failed to fetch transaction statement: Transaction not found for transaction ID: x"), status = 400)
        assertEquals(PaymentStatus.NOT_FOUND, g.verify(VerifyInput("P1", 120000)).status)
        mock.respond("oops", status = 500)
        assertFailsWith<PaymentException> { g.verify(VerifyInput("P1", 120000)) }
    }
}
