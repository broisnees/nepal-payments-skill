package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import javax.crypto.Cipher
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

private val keyPair: KeyPair by lazy { KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair() }

private fun verifySig(b64sig: String, message: String): Boolean =
    Signature.getInstance("SHA256withRSA").run {
        initVerify(keyPair.public)
        update(message.toByteArray(Charsets.UTF_8))
        verify(fromBase64(b64sig))
    }

private fun txn(vararg o: Pair<String, Any?>): Map<String, Any?> =
    linkedMapOf<String, Any?>("nQrTxnId" to "2312060000059575KMB", "amount" to BigDecimal("10.5"), "tranType" to "PMT", "merchantBillNo" to "P1") + o

private fun report(vararg rows: Map<String, Any?>): Map<String, Any?> =
    linkedMapOf("timestamp" to "2024-02-07T07:10:47.928+0000", "responseCode" to "200", "responseStatus" to "SUCCESS", "responseBody" to rows.toList())

class NepalPayTest {
    private val mock = MockTransport()
    private val pem = "-----BEGIN PRIVATE KEY-----\n" + toBase64(keyPair.private.encoded).chunked(64).joinToString("\n") + "\n-----END PRIVATE KEY-----"
    private val base = NepalPayConfig(
        env = Environment.SANDBOX,
        acquirerId = "00001701",
        merchantId = "17012UVSTIR",
        merchantName = "BBSM",
        merchantCategoryCode = "5021",
        merchantCity = "Kathmandu",
        merchantPostalCode = "4600",
        storeLabel = "Store1",
        terminalLabel = "Terminal1",
        username = "npiuser",
        password = "pw",
        privateKey = loadPkcs8PrivateKey(pem),
    )
    private val n = NepalPay(base, mock)
    private val generated = """{"timestamp":"2022-05-23 04:25:26","responseCode":"000","responseStatus":"SUCCESS",""" +
        """"responseMessage":"QR String generated successfully.",""" +
        """"data":{"validationTraceId":"2205260000001900KIY","qrString":" 000201010212...6304607F","qrImage":"iVBORw0KGgo="}}"""

    @Test
    @DisplayName("[ts] token string: comma-joined, no spaces, userId last")
    fun tokenString() {
        assertEquals(
            "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser",
            nepalPayTokenString("00001701", "17012UVSTIR", "5021", "524", "10.50", "P1", "npiuser"),
        )
    }

    @Test
    @DisplayName("[ts] initiate: dynamic QR (12), rupees with 2 decimals, signed token, Basic auth, qr result")
    fun initiate() = suspendTest {
        mock.respond(generated)
        val r = n.initiate(InitiateInput("P1", 1050, "Everest T-shirt, large and blue", ""))
        assertEquals("https://devopennpi.connectips.com/qr/generateQR", mock.calls[0].url)
        assertEquals("Basic " + b64("npiuser:pw"), mock.calls[0].header("Authorization"))
        val body = mock.calls[0].jsonBody()
        assertEquals(BigDecimal(12), body["pointOfInitialization"])
        assertEquals("10.50", body["transactionAmount"])
        assertEquals(BigDecimal(524), body["transactionCurrency"])
        assertEquals("P1", body["billNumber"])
        assertEquals(25, (body["purposeOfTransaction"] as String).length)
        assertEquals(true, body["qrImage"])
        assertTrue(verifySig(body["token"] as String, "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"))
        assertEquals(InitiateResult.Qr("000201010212...6304607F", "iVBORw0KGgo=", "2205260000001900KIY", Json.parse(generated)), r)
        mock.respond(generated)
        n.initiate(InitiateInput("P2", 100000, "x", ""))
        assertEquals("1000.00", mock.calls[0].jsonBody()["transactionAmount"])
    }

    @Test
    @DisplayName("[ts] initiate: billNumber charset/length, error codes surface")
    fun initiateErrors() = suspendTest {
        val err = assertFailsWith<PaymentException> { n.initiate(InitiateInput("X".repeat(26), 100, "x", "")) }
        assertContains(err.message!!, "1–25")
        mock.respond("""{"responses":[{"responseCode":"E003","responseMessage":"INVALID TOKEN"}]}""", status = 400)
        assertEquals("E003", assertFailsWith<PaymentException> { n.initiate(InitiateInput("P1", 100, "x", "")) }.code)
    }

    @Test
    @DisplayName("[ts] verify: report by validationTraceId; a success after a failed scan counts")
    fun verifyAfterFailedScan() = suspendTest {
        mock.respond(
            report(
                txn("nQrTxnId" to "A", "debitStatus" to "E001", "creditStatus" to null),
                txn("nQrTxnId" to "B", "debitStatus" to "000", "creditStatus" to "DEFER"),
            ),
        )
        val v = n.verify(VerifyInput("P1", 1050, providerRef = "2205260000001900KIY"))
        assertEquals("https://devopennpi.connectips.com/nQR/v1/merchanttxnreport", mock.calls[0].url)
        assertEquals(
            mapOf("validationTraceId" to "2205260000001900KIY", "merchantId" to "17012UVSTIR", "acquirerId" to "00001701"),
            mock.calls[0].jsonBody(),
        )
        assertEquals(Triple(PaymentStatus.PAID, 1050L, "B"), Triple(v.status, v.amountPaisa, v.transactionId))
    }

    @Test
    @DisplayName("[ts] verify: status mapping")
    fun statusMapping() = suspendTest {
        val cases = listOf<Pair<Any?, PaymentStatus>>(
            report(txn("debitStatus" to "000", "creditStatus" to "000")) to PaymentStatus.PAID,
            report(txn("debitStatus" to "000", "creditStatus" to "999")) to PaymentStatus.PAID,
            report(txn("debitStatus" to "000", "creditStatus" to "E99")) to PaymentStatus.UNKNOWN,
            report(txn("debitStatus" to "E001", "creditStatus" to null)) to PaymentStatus.FAILED,
            report(txn("debitStatus" to "000", "creditStatus" to "000", "tranType" to "RFND")) to PaymentStatus.NOT_FOUND,
            report() to PaymentStatus.NOT_FOUND,
            mapOf("responseCode" to "E010", "responseMessage" to "RECORD NOT FOUND") to PaymentStatus.NOT_FOUND,
        )
        for ((body, want) in cases) {
            mock.respond(body)
            assertEquals(want, n.verify(VerifyInput("P1", 1050, providerRef = "T")).status)
        }
        assertEquals("missing_provider_ref", assertFailsWith<PaymentException> { n.verify(VerifyInput("P1", 1050)) }.code)
    }

    @Test
    @DisplayName("[ts] oauth: password grant once, Bearer reused until expiry")
    fun oauth() = suspendTest {
        val o = NepalPay(base.copy(auth = NepalPayAuth.OAUTH, clientId = "cid", clientSecret = "csec"), mock)
        mock.calls.clear()
        mock.handler = {
            val body = if (it.url.endsWith("/oauth/token")) mapOf("access_token" to "AT1", "token_type" to "bearer", "expires_in" to 299) else report()
            TransportResponse(200, Json.stringify(body))
        }
        o.verify(VerifyInput("P1", 100, providerRef = "T"))
        o.verify(VerifyInput("P1", 100, providerRef = "T"))
        assertEquals(3, mock.calls.size)
        assertEquals("Basic " + b64("cid:csec"), mock.calls[0].header("Authorization"))
        assertEquals("grant_type=password&username=npiuser&password=pw", mock.calls[0].body)
        assertEquals("Bearer AT1", mock.calls[1].header("Authorization"))
        assertEquals("Bearer AT1", mock.calls[2].header("Authorization"))
    }

    @Test
    @DisplayName("[ts] confirm-payment reply is signed over txnDate,status,message,merchantBillNo,paymentRef")
    fun confirmation() {
        val r = n.confirmationResponse(txnDate = "2024-11-10 01:35:31", merchantBillNo = "P1", paymentRef = "2411100000067378ZHU")
        assertTrue(verifySig(r.getValue("signature"), "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU"))
        assertEquals("P1", n.orderIdFromCallback(mapOf("merchantBillNo" to "P1")))
    }

    private val spki = "-----BEGIN PUBLIC KEY-----\n" + toBase64(keyPair.public.encoded).chunked(64).joinToString("\n") + "\n-----END PUBLIC KEY-----"
    private val withNchl = NepalPay(
        base.copy(nchlPublicKey = loadSpkiPublicKey(spki), wsUrl = "wss://ws.example/nqrws", wsUsername = "wsuser", wsApiToken = "secret-api-token"),
        mock,
    )

    @Test
    @DisplayName("[ts] confirm-payment notification: signature over the documented string, payerMobile fallback")
    fun confirmationNotification() {
        val note = linkedMapOf<String, Any?>(
            "merchantBillNo" to "NA", "merchantId" to "0010SVQNL9H", "merchantName" to "Quantum Labs", "paymentRef" to "2411100000067378ZHU",
            "channel" to "CIPS", "payerMobile" to "+977-9843705813", "sessionNo" to "5446", "status" to "SUCCESS",
        )
        val msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446"
        assertEquals(msg, nepalPayConfirmationString(note))
        val sig = Signature.getInstance("SHA256withRSA").run {
            initSign(keyPair.private)
            update(msg.toByteArray(Charsets.UTF_8))
            toBase64(sign())
        }
        assertTrue(withNchl.verifyConfirmation(note + ("signature" to sig)))
        assertFalse(withNchl.verifyConfirmation(note + mapOf("sessionNo" to "5447", "signature" to sig)))
        assertFalse(withNchl.verifyConfirmation(note + ("signature" to "not base64!")))
        assertFalse(withNchl.verifyConfirmation(note))
        assertContains(assertFailsWith<IllegalStateException> { n.verifyConfirmation(note) }.message!!, "nchlPublicKey")
        // payerMobileNumber (the documented name) wins; null fields sign as "".
        assertEquals(
            "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,,9800000000,5446",
            nepalPayConfirmationString(note + mapOf("channel" to null, "payerMobileNumber" to "9800000000")),
        )
        assertTrue(rsaSha256VerifyBase64(spki, msg, sig))
        assertFalse(rsaSha256VerifyBase64("not a pem", msg, sig))
    }

    @Test
    @DisplayName("[ts] WebSocket request: destinations, terminal as merchant_id, api_token RSA PKCS#1 v1.5 encrypted")
    fun webSocketRequest() {
        val w = withNchl.webSocketRequest("2205260000001900KIY")
        assertEquals(
            listOf("wss://ws.example/nqrws", "/user/nqrws/check-txn-status", "/nqrws/check-txn-status", "Terminal1", "2205260000001900KIY", "wsuser"),
            listOf(w.url, w.subscribe, w.send, w.body["merchant_id"], w.body["request_id"], w.body["username"]),
        )
        val ct = fromBase64(w.body.getValue("api_token"))
        assertEquals(256, ct.size)
        val plain = Cipher.getInstance("RSA/ECB/PKCS1Padding").run {
            init(Cipher.DECRYPT_MODE, keyPair.private)
            String(doFinal(ct), Charsets.UTF_8)
        }
        assertEquals("secret-api-token", plain)
        assertNotEquals(withNchl.webSocketRequest("X").body["api_token"], withNchl.webSocketRequest("X").body["api_token"])
        assertEquals("0", NepalPay(withNchl.config.copy(terminalLabel = null), mock).webSocketRequest("X").body["merchant_id"])
        assertContains(assertFailsWith<IllegalStateException> { n.webSocketRequest("X") }.message!!, "wsUrl")
        assertEquals(256, fromBase64(rsaPkcs1EncryptBase64(spki, "x".repeat(245))).size) // k - 11 is the limit
        assertContains(assertFailsWith<IllegalArgumentException> { rsaPkcs1EncryptBase64(spki, "x".repeat(246)) }.message!!, "too long")
    }

    @Test
    @DisplayName("env: NCHL public key PEM and WebSocket vars")
    fun envNchl() {
        val env = mapOf(
            "NEPALPAY_ACQUIRER_ID" to "00001701", "NEPALPAY_MERCHANT_ID" to "17012UVSTIR", "NEPALPAY_USERNAME" to "npiuser",
            "NEPALPAY_PRIVATE_KEY_PEM" to pem.replace("\n", "\\n"), "NEPALPAY_NCHL_PUBLIC_KEY_PEM" to spki.replace("\n", "\\n"),
            "NEPALPAY_WS_URL" to "wss://ws.example/nqrws", "NEPALPAY_WS_USERNAME" to "wsuser", "NEPALPAY_WS_API_TOKEN" to "tok",
        )
        val c = paymentsConfigFromEnv(env).nepalpay!!
        assertEquals(keyPair.public, c.nchlPublicKey)
        assertEquals(Triple("wss://ws.example/nqrws", "wsuser", "tok"), Triple(c.wsUrl, c.wsUsername, c.wsApiToken))
        val bare = paymentsConfigFromEnv(env - "NEPALPAY_NCHL_PUBLIC_KEY_PEM" - "NEPALPAY_WS_URL").nepalpay!!
        assertEquals(listOf<Any?>(null, null, null, null), listOf(bare.nchlPublicKey, bare.wsUrl, bare.wsUsername, bare.wsApiToken))
    }
}
