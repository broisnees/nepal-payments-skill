/*
 * connectIPS (NCHL) e-payment gateway — https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
 * Port of scripts/ts/src/providers/connectips/. Onboarding via your bank -> NCHL emails MERCHANTID, APPID, APPNAME,
 * app password and the creditor .pfx.
 *
 * Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to loginpage
 *       -> connectIPS redirects to your registered success/failure URL with ?TXNID=... -> validatetxn (Basic auth).
 *
 * Key: loadPfxPrivateKey(File("CREDITOR.pfx").readBytes(), password) or loadPkcs8PrivateKey(pem).
 */
package np.payments

import java.math.BigDecimal
import java.math.RoundingMode
import java.security.PrivateKey
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class ConnectIpsConfig(
    val env: Environment,
    val merchantId: String,
    /** e.g. "MER-550-APP-1". */
    val appId: String,
    /** <= 30 chars. */
    val appName: String,
    /** App password for Basic auth on validatetxn / gettxndetail. */
    val appPassword: String,
    /** Creditor private key: [loadPfxPrivateKey] (the .pfx as issued) or [loadPkcs8PrivateKey] (PEM). */
    val privateKey: PrivateKey,
    val baseUrl: String? = null,
    val timeout: Duration = 20.seconds,
) {
    override fun toString() =
        "ConnectIpsConfig(env=$env, merchantId=$merchantId, appId=$appId, appName=$appName, appPassword=***, privateKey=***, baseUrl=$baseUrl, timeout=$timeout)"
}

data class ConnectIpsInitiateExtras(val referenceId: String? = null, val remarks: String? = null, val particulars: String? = null)

/** validatetxn / gettxndetail response. creditStatus "000"/"999"/"DEFER" = credited / OK. */
data class ConnectIpsTxnDetail(
    val status: String,
    val statusDesc: String?,
    val referenceId: String?,
    val txnAmt: String?,
    val txnId: String?,
    val batchId: String?,
    val debitBankCode: String?,
    val chargeAmt: String?,
    val chargeLiability: String?,
    val creditStatus: String?,
    val raw: Map<String, Any?>,
)

private val CONNECTIPS_DATE = DateTimeFormatter.ofPattern("dd-MM-yyyy", Locale.ROOT)
private val CONNECTIPS_TXNID = Regex("^[A-Za-z0-9-]{1,20}$")

/** DD-MM-YYYY in Asia/Kathmandu. */
fun connectIpsDate(at: Instant = Instant.now()): String = CONNECTIPS_DATE.format(at.atZone(ZoneId.of("Asia/Kathmandu")))

/** The exact string connectIPS expects to be signed for the gateway form. */
fun connectIpsTokenString(f: Map<String, String>): String {
    fun v(k: String) = f[k] ?: ""
    return "MERCHANTID=${v("MERCHANTID")},APPID=${v("APPID")},APPNAME=${v("APPNAME")},TXNID=${v("TXNID")},TXNDATE=${v("TXNDATE")}," +
        "TXNCRNCY=${v("TXNCRNCY")},TXNAMT=${v("TXNAMT")},REFERENCEID=${v("REFERENCEID")},REMARKS=${v("REMARKS")}," +
        "PARTICULARS=${v("PARTICULARS")},TOKEN=TOKEN"
}

/** Commas/equals would corrupt the token string. */
private fun clip(s: String, n: Int) = s.replace(Regex("[,=]"), " ").take(n)

class ConnectIps(val config: ConnectIpsConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.CONNECTIPS

    private val http = Http(id, transport)
    private val base = config.baseUrl ?: if (config.env == Environment.SANDBOX) "https://uat.connectips.com" else "https://login.connectips.com"
    private val auth = mapOf("Authorization" to basicAuth(config.appId, config.appPassword))

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, ConnectIpsInitiateExtras())

    /**
     * Form POST to the connectIPS login page. TXNID = orderId (<= 20 chars, unique per app).
     * Success/failure redirect URLs are REGISTERED WITH NCHL, not sent per request; returnUrl is unused here.
     */
    suspend fun initiate(input: InitiateInput, extras: ConnectIpsInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (!CONNECTIPS_TXNID.matches(input.orderId)) {
            throw PaymentException("connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", id, "invalid_order_id")
        }
        val f = linkedMapOf(
            "MERCHANTID" to config.merchantId,
            "APPID" to config.appId,
            "APPNAME" to config.appName.take(30),
            "TXNID" to input.orderId,
            "TXNDATE" to connectIpsDate(),
            "TXNCRNCY" to "NPR",
            "TXNAMT" to input.amountPaisa.toString(), // PAISA
            // Empty extras fall back too (JS `||`, not `??`).
            "REFERENCEID" to clip(extras.referenceId.orNullIfEmpty() ?: input.orderId, 20),
            "REMARKS" to clip(extras.remarks.orNullIfEmpty() ?: input.description, 50).ifEmpty { "Payment" },
            "PARTICULARS" to clip(extras.particulars.orNullIfEmpty() ?: input.description, 100).ifEmpty { "Payment" },
        )
        f["TOKEN"] = rsaSha256SignBase64(config.privateKey, connectIpsTokenString(f))
        return InitiateResult.Form(action = "$base/connectipswebgw/loginpage", fields = f)
    }

    /** validatetxn: authoritative. SUCCESS + amount match = paid. */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val r = validationCall("validatetxn", input.orderId, input.amountPaisa)
        val desc = jsString(r["statusDesc"] ?: "").uppercase()
        val status = when {
            r["status"] == "SUCCESS" -> PaymentStatus.PAID
            r["status"] == "FAILED" -> PaymentStatus.FAILED
            desc.contains("NOT FOUND") -> PaymentStatus.NOT_FOUND
            desc.contains("INCOMPLETE") -> PaymentStatus.PENDING // user hasn't finished OTP yet
            else -> PaymentStatus.UNKNOWN
        }
        return VerifyResult(id, status, input.orderId, roundedPaisa(r["txnAmt"]), null, r)
    }

    /** Full detail incl. NCHL txnId, bank, charges and creditStatus ("000"/"999"/"DEFER" = credited/OK). */
    suspend fun getTxnDetail(orderId: String, amountPaisa: Long): ConnectIpsTxnDetail {
        val r = validationCall("gettxndetail", orderId, amountPaisa)
        fun s(k: String) = r[k]?.let(::jsString)
        return ConnectIpsTxnDetail(
            status = jsString(r["status"]), statusDesc = s("statusDesc"), referenceId = s("referenceId"), txnAmt = s("txnAmt"),
            txnId = s("txnId"), batchId = s("batchId"), debitBankCode = s("debitBankCode"), chargeAmt = s("chargeAmt"),
            chargeLiability = s("chargeLiability"), creditStatus = s("creditStatus"), raw = r,
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? =
        params["TXNID"].orNullIfEmpty() ?: params["txnId"].orNullIfEmpty()

    private suspend fun validationCall(path: String, txnId: String, amountPaisa: Long): Map<String, Any?> {
        val tokenString = "MERCHANTID=${config.merchantId},APPID=${config.appId},REFERENCEID=$txnId,TXNAMT=$amountPaisa"
        val body = linkedMapOf<String, Any?>(
            "merchantId" to config.merchantId.trim().toBigDecimalOrNull(), // JSON number, like TS Number(merchantId)
            "appId" to config.appId,
            "referenceId" to txnId, // NOTE: the TXNID you sent, not REFERENCEID
            "txnAmt" to amountPaisa,
            "token" to rsaSha256SignBase64(config.privateKey, tokenString),
        )
        val res = http.request("$base/connectipswebws/api/creditor/$path", "POST", auth, body, config.timeout, retries = 2)
        if (res.status == 401) throw PaymentException("connectIPS: 401 — wrong APPID/app password", id, "unauthorized", 401)
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null || !jsTruthy(data["status"])) {
            throw PaymentException("connectIPS $path failed: ${res.text.take(200)}", id, "http_${res.status}", res.status, res.data)
        }
        return data
    }

    /** JS Math.round(Number(x)) for txnAmt; null when absent or not numeric. */
    private fun roundedPaisa(v: Any?): Long? {
        val n: BigDecimal = when (v) {
            is BigDecimal -> v
            is String -> if (v.isBlank()) BigDecimal.ZERO else v.trim().toBigDecimalOrNull() ?: return null
            else -> return null
        }
        if (n.abs() > BigDecimal("1e18")) return null
        return n.add(BigDecimal("0.5")).setScale(0, RoundingMode.FLOOR).longValueExact()
    }
}
