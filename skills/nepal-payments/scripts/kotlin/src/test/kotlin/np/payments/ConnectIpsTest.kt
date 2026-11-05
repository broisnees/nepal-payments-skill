package np.payments

import org.junit.jupiter.api.DisplayName
import java.io.File
import java.math.BigDecimal
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.Signature
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val keyPair: KeyPair by lazy { KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair() }

private fun pemOf(der: ByteArray) =
    "-----BEGIN PRIVATE KEY-----\n" + toBase64(der).chunked(64).joinToString("\n") + "\n-----END PRIVATE KEY-----"

private fun rsaVerify(pub: PublicKey, message: String, b64sig: String): Boolean =
    Signature.getInstance("SHA256withRSA").run {
        initVerify(pub)
        update(message.toByteArray(Charsets.UTF_8))
        verify(fromBase64(b64sig))
    }

class ConnectIpsTest {
    private val mock = MockTransport()
    private val pem = pemOf(keyPair.private.encoded)
    private val c = ConnectIps(ConnectIpsConfig(Environment.SANDBOX, "550", "MER-550-APP-1", "Test", "pw", loadPkcs8PrivateKey(pem)), mock)

    @Test
    @DisplayName("[ts] TOKEN is RSA-SHA256 over the documented string, amount in paisa, DD-MM-YYYY")
    fun token() = suspendTest {
        val r = c.initiate(InitiateInput("txn123", 500, "Order, #1", "")) as InitiateResult.Form
        assertEquals("500", r.fields["TXNAMT"])
        assertTrue(Regex("^\\d{2}-\\d{2}-\\d{4}$").matches(r.fields.getValue("TXNDATE")))
        assertEquals("Order  #1", r.fields["REMARKS"]) // commas stripped: they'd corrupt the token string
        val msg = connectIpsTokenString(r.fields)
        assertTrue(msg.endsWith(",PARTICULARS=Order  #1,TOKEN=TOKEN"))
        assertTrue(rsaVerify(keyPair.public, msg, r.fields.getValue("TOKEN")))
    }

    @Test
    @DisplayName("[ts] TXNID max 20 chars")
    fun txnIdMax() = suspendTest {
        val err = assertFailsWith<PaymentException> { c.initiate(InitiateInput("X".repeat(21), 100, "x", "")) }
        assertContains(err.message!!, "1–20")
    }

    @Test
    @DisplayName("[ts] validatetxn: referenceId = TXNID, Basic auth, status mapping")
    fun validatetxn() = suspendTest {
        for ((status, desc, n) in listOf(
            Triple("SUCCESS", "TRANSACTION SUCCESSFUL", PaymentStatus.PAID),
            Triple("FAILED", "TRANSACTION UNSUCCESSFUL", PaymentStatus.FAILED),
            Triple("ERROR", "TRANSACTION NOT FOUND", PaymentStatus.NOT_FOUND),
            Triple("ERROR", "TRANSACTION INCOMPLETE", PaymentStatus.PENDING),
        )) {
            mock.respond("""{"merchantId":550,"appId":"MER-550-APP-1","referenceId":"txn123","txnAmt":"500","status":"$status","statusDesc":"$desc"}""")
            val v = c.verify(VerifyInput("txn123", 500))
            assertEquals(n, v.status)
            val body = mock.calls[0].jsonBody()
            assertEquals("txn123", body["referenceId"])
            assertEquals(BigDecimal(500), body["txnAmt"])
            assertEquals("Basic " + b64("MER-550-APP-1:pw"), mock.calls[0].header("Authorization"))
            assertEquals("https://uat.connectips.com/connectipswebws/api/creditor/validatetxn", mock.calls[0].url)
        }
    }

    @Test
    @DisplayName("[kt] validatetxn token signs MERCHANTID,APPID,REFERENCEID=TXNID,TXNAMT; amount parsed; '=' clipped")
    fun validationToken() = suspendTest {
        mock.respond("""{"referenceId":"txn123","txnAmt":500,"status":"SUCCESS","statusDesc":"OK"}""")
        val v = c.verify(VerifyInput("txn123", 500))
        val body = mock.calls[0].jsonBody()
        assertEquals(BigDecimal(550), body["merchantId"])
        assertTrue(rsaVerify(keyPair.public, "MERCHANTID=550,APPID=MER-550-APP-1,REFERENCEID=txn123,TXNAMT=500", body["token"] as String))
        assertEquals(500, v.amountPaisa)
        val f = (c.initiate(InitiateInput("t1", 100, "a=b,c", ""), ConnectIpsInitiateExtras(referenceId = "R=1,2")) as InitiateResult.Form).fields
        assertEquals("a b c", f["PARTICULARS"])
        assertEquals("R 1 2", f["REFERENCEID"])
        assertEquals("t1", c.orderIdFromCallback(mapOf("TXNID" to "t1")))
        mock.respond("""{"message":"Unauthorized"}""", status = 401)
        assertEquals("unauthorized", assertFailsWith<PaymentException> { c.verify(VerifyInput("txn123", 500)) }.code)
    }

    @Test
    @DisplayName("[kt] creditor .pfx loads via KeyStore PKCS12 and signs identically to its PKCS#8 PEM")
    fun pfx() = suspendTest {
        val dir = Files.createTempDirectory("cips").toFile()
        try {
            val pfx = File(dir, "CREDITOR.pfx")
            val keytool = File(System.getProperty("java.home"), "bin/keytool").path
            val proc = ProcessBuilder(
                keytool, "-genkeypair", "-alias", "creditor", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
                "-dname", "CN=test", "-storetype", "PKCS12", "-keystore", pfx.path, "-storepass", "s3cret!", "-keypass", "s3cret!",
            ).redirectErrorStream(true).start()
            val out = proc.inputStream.bufferedReader().readText()
            assertEquals(0, proc.waitFor(), out)

            val key = loadPfxPrivateKey(pfx.readBytes(), "s3cret!".toCharArray())
            val cert = KeyStore.getInstance("PKCS12").apply { pfx.inputStream().use { load(it, "s3cret!".toCharArray()) } }.getCertificate("creditor")
            val fromPfx = ConnectIps(ConnectIpsConfig(Environment.SANDBOX, "550", "MER-550-APP-1", "Test", "pw", key), mock)
            val fields = (fromPfx.initiate(InitiateInput("txn9", 500, "x", "")) as InitiateResult.Form).fields
            assertTrue(rsaVerify(cert.publicKey, connectIpsTokenString(fields), fields.getValue("TOKEN")))
            assertEquals(rsaSha256SignBase64(key, "m"), rsaSha256SignBase64(pemOf(key.encoded), "m"))
            assertEquals(key, loadPfxPrivateKey(pfx.readBytes(), "s3cret!".toCharArray(), alias = "creditor"))
            assertFailsWith<Exception> { loadPfxPrivateKey(pfx.readBytes(), "wrong".toCharArray()) }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    @DisplayName("[kt] PKCS#1 PEM is rejected with the conversion hint")
    fun pkcs1() {
        val err = assertFailsWith<IllegalArgumentException> { loadPkcs8PrivateKey("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----") }
        assertContains(err.message!!, "openssl pkcs8 -topk8")
    }
}
