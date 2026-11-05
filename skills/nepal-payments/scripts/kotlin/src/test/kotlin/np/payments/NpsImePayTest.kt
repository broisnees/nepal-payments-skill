package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class NpsTest {
    private val mock = MockTransport()
    private val n = Nps(NpsConfig(Environment.SANDBOX, "9", "TestMerchant", "u", "p", "secret"), mock)

    private fun hmacHex(msg: String) = toHex(javax.crypto.Mac.getInstance("HmacSHA512").run {
        init(javax.crypto.spec.SecretKeySpec("secret".toByteArray(), "HmacSHA512"))
        doFinal(msg.toByteArray())
    })

    @Test
    @DisplayName("[ts] signature = HMAC-SHA512 hex of values of alphabetically sorted keys, no separator")
    fun sign() {
        val p = linkedMapOf("MerchantTxnId" to "T1", "MerchantName" to "TestMerchant", "Amount" to "100", "MerchantId" to "9")
        assertEquals(hmacHex("100" + "9" + "TestMerchant" + "T1"), npsSign("secret", p))
        assertEquals(hmacHex("9TestMerchant"), npsSign("secret", mapOf("MerchantId" to "9", "MerchantName" to "TestMerchant")))
    }

    @Test
    @DisplayName("[ts] initiate: GetProcessId then multipart form with matching Amount/MerchantTxnId")
    fun initiate() = suspendTest {
        mock.respond("""{"code":"0","message":"Success","errors":[],"data":{"ProcessId":"PROC_1"}}""")
        val r = n.initiate(InitiateInput("T1", 10000, "x", "https://r")) as InitiateResult.Form
        assertEquals("https://apisandbox.nepalpayment.com/GetProcessId", mock.calls[0].url)
        assertEquals(
            npsSign("secret", mapOf("MerchantId" to "9", "MerchantName" to "TestMerchant", "Amount" to "100", "MerchantTxnId" to "T1")),
            mock.calls[0].jsonBody()["Signature"],
        )
        assertEquals(InitiateResult.MULTIPART, r.enctype)
        assertEquals("100", r.fields["Amount"])
        assertEquals("PROC_1", r.fields["ProcessId"])
        assertEquals("https://gatewaysandbox.nepalpayment.com/Payment/Index", r.action)
    }

    @Test
    @DisplayName("[ts] status: code 0 + Fail is a failed payment; error_code 3 is not_found")
    fun status() = suspendTest {
        mock.respond("""{"code":"0","message":"","errors":[],"data":{"Status":"Fail","Amount":"100","MerchantTxnId":"T1"}}""")
        assertEquals(PaymentStatus.FAILED, n.verify(VerifyInput("T1", 10000)).status)
        mock.respond("""{"code":"0","message":"","errors":[],"data":{"Status":"Success","Amount":"100.00","MerchantTxnId":"T1","GatewayReferenceNo":"G1"}}""")
        val v = n.verify(VerifyInput("T1", 10000))
        assertEquals(PaymentStatus.PAID, v.status)
        assertEquals(10000, v.amountPaisa)
        mock.respond("""{"code":"1","message":"","errors":[{"error_code":"3","error_message":"Transaction not initialized yet"}],"data":null}""")
        assertEquals(PaymentStatus.NOT_FOUND, n.verify(VerifyInput("T1", 10000)).status)
    }

    @Test
    @DisplayName("[py] initiate returns ProcessId as providerRef; Fail without Amount -> failed, null amount")
    fun providerRef() = suspendTest {
        mock.respond("""{"code":"0","message":"","errors":[],"data":{"ProcessId":"PROC_1"}}""")
        assertEquals("PROC_1", n.initiate(InitiateInput("T1", 10000, "x", "https://r")).providerRef)
        mock.respond("""{"code":"0","errors":[],"data":{"Status":"Fail","MerchantTxnId":"T1"}}""")
        val v = n.verify(VerifyInput("T1", 10000))
        assertEquals(PaymentStatus.FAILED, v.status)
        assertNull(v.amountPaisa)
    }

    @Test
    @DisplayName("[kt] other errors throw nps_<code>; other txn rejected; notification acked only when final")
    fun errorsAndAck() = suspendTest {
        mock.respond("""{"code":"1","message":"bad","errors":[{"error_code":"2","error_message":"Duplicate Record"}],"data":null}""")
        val e = assertFailsWith<PaymentException> { n.initiate(InitiateInput("T1", 10000, "x", "https://r")) }
        assertEquals("nps_2", e.code)
        mock.respond("""{"code":"0","errors":[],"data":{"Status":"Success","Amount":"100","MerchantTxnId":"T2"}}""")
        assertEquals("callback_mismatch", assertFailsWith<PaymentException> { n.verify(VerifyInput("T1", 10000)) }.code)
        assertEquals("T1", n.orderIdFromCallback(mapOf("MerchantTxnId" to "T1", "GatewayTxnId" to "G")))
        assertEquals("received", n.notificationResponse(false))
        assertEquals("already received", n.notificationResponse(true))
        assertEquals("received", n.notificationAck(wasFinal = false, current = PaymentStatus.PAID))
        assertEquals("already received", n.notificationAck(wasFinal = true, current = PaymentStatus.FAILED))
        assertNull(n.notificationAck(wasFinal = false, current = PaymentStatus.PENDING))
        assertNull(n.notificationAck(wasFinal = false, current = AttemptStatus.Initiated))
    }
}

class ImePayTest {
    private val mock = MockTransport()
    private val i = ImePay(ImePayConfig(Environment.SANDBOX, "MC", "u", "p", "MOD"), mock)

    @Test
    @DisplayName("[ts] GetToken + checkout payload format (official plugin)")
    fun getToken() = suspendTest {
        mock.respond("""{"TokenId":"TK1","ResponseCode":0}""")
        val r = i.initiate(InitiateInput("R1", 10000, "x", "https://s/ok", failureUrl = "https://s/no")) as InitiateResult.Redirect
        assertEquals("https://stg.imepay.com.np:7979/api/Web/GetToken", mock.calls[0].url)
        assertEquals(b64("MOD"), mock.calls[0].header("Module"))
        assertEquals(mapOf("MerchantCode" to "MC", "Amount" to "100.00", "RefId" to "R1"), mock.calls[0].jsonBody())
        val data = queryParams(r.url).getValue("data")
        assertEquals("TK1|MC|R1|100.00|POST|https://s/ok|https://s/no", String(fromBase64(data), Charsets.UTF_8))
    }

    @Test
    @DisplayName("[ts] Recheck: 0 = paid; anything else stays pending (sources disagree)")
    fun recheck() = suspendTest {
        mock.respond("""{"ResponseCode":0,"RefId":"R1","TranAmount":"100.00","TransactionId":"X9"}""")
        assertEquals(PaymentStatus.PAID, i.verify(VerifyInput("R1", 10000, providerRef = "TK1")).status)
        mock.respond("""{"ResponseCode":1,"RefId":"R1"}""")
        assertEquals(PaymentStatus.PENDING, i.verify(VerifyInput("R1", 10000, providerRef = "TK1")).status)
        mock.respond("""{"ResponseCode":0,"RefId":"R1","TranAmount":""}""")
        assertNull(i.verify(VerifyInput("R1", 10000, providerRef = "TK1")).amountPaisa) // -> review, no throw
    }

    @Test
    @DisplayName("[kt] Recheck amount/txn id parsed; other RefId rejected; TokenId required")
    fun recheckEdges() = suspendTest {
        mock.respond("""{"ResponseCode":0,"RefId":"R1","TranAmount":100.5,"TransactionId":12345}""")
        val v = i.verify(VerifyInput("R1", 10050, providerRef = "TK1"))
        assertEquals(10050, v.amountPaisa)
        assertEquals("12345", v.transactionId)
        assertEquals(mapOf("MerchantCode" to "MC", "RefId" to "R1", "TokenId" to "TK1"), mock.calls[0].jsonBody())
        mock.respond("""{"ResponseCode":0,"RefId":"R2"}""")
        assertEquals("callback_mismatch", assertFailsWith<PaymentException> { i.verify(VerifyInput("R1", 1, providerRef = "TK1")) }.code)
        assertEquals("missing_token", assertFailsWith<PaymentException> { i.verify(VerifyInput("R1", 1)) }.code)
        mock.respond("""{"ResponseCode":"1","ResponseDescription":"Invalid"}""")
        assertEquals("imepay_1", assertFailsWith<PaymentException> { i.initiate(InitiateInput("R1", 100, "x", "https://s")) }.code)
        assertEquals(BigDecimal("100.5"), (v.raw as Map<*, *>)["TranAmount"])
    }
}
