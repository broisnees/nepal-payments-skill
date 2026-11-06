/*
 * NEPALPAY QR (NCHL) merchant dynamic QR: https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
 * Port of scripts/ts/src/nepalpay.ts. Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId,
 * merchantId, MCC, NPI username/password, and the signing .pfx (NPI.pfx in UAT).
 *
 * Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qrString / qrImage -> customer scans with any
 *       NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= providerRef).
 *
 * Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
 * Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
 *
 * Key: loadPfxPrivateKey(File("NPI.pfx").readBytes(), password) or loadPkcs8PrivateKey(pem).
 */
package np.payments

import java.security.PrivateKey
import java.security.PublicKey
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** [BASIC] (merchant QR doc) or [OAUTH] (NPI password grant, needs clientId/clientSecret). */
enum class NepalPayAuth { BASIC, OAUTH }

data class NepalPayConfig(
    val env: Environment,
    /** 8 digits, e.g. "00002501" (your acquiring bank). */
    val acquirerId: String,
    /** Creditor id / merchant code, e.g. "2501ELFDRY2". */
    val merchantId: String,
    /** <= 25 chars; must match the enrolled name. */
    val merchantName: String,
    /** Digits, e.g. "5021". Signed as text, sent as a JSON number. */
    val merchantCategoryCode: String,
    val merchantCity: String,
    val merchantPostalCode: String,
    val storeLabel: String,
    val terminalLabel: String? = null,
    /** NPI user issued to the merchant. Also the `userId` inside the signed token. */
    val username: String,
    val password: String,
    /** Key from the NPI .pfx: [loadPfxPrivateKey] (the .pfx as issued) or [loadPkcs8PrivateKey] (PEM). */
    val privateKey: PrivateKey,
    val auth: NepalPayAuth = NepalPayAuth.BASIC,
    val clientId: String? = null,
    val clientSecret: String? = null,
    /** Ask NCHL for a base64 PNG alongside the QR string. */
    val qrImage: Boolean = true,
    /** NCHL's public key (from NPI.cer, see [loadSpkiPublicKey]): verifies confirm-payment notifications, encrypts the WebSocket api_token. */
    val nchlPublicKey: PublicKey? = null,
    /** WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own username and API token. */
    val wsUrl: String? = null,
    val wsUsername: String? = null,
    val wsApiToken: String? = null,
    val baseUrl: String? = null,
    val timeout: Duration = 20.seconds,
) {
    override fun toString() =
        "NepalPayConfig(env=$env, acquirerId=$acquirerId, merchantId=$merchantId, merchantName=$merchantName, " +
            "merchantCategoryCode=$merchantCategoryCode, username=$username, password=***, privateKey=***, auth=$auth, " +
            "clientId=$clientId, clientSecret=***, wsUrl=$wsUrl, wsUsername=$wsUsername, wsApiToken=***, baseUrl=$baseUrl, timeout=$timeout)"
}

/** One merchanttxnreport row. [raw] keeps every field NCHL sent. */
data class NepalPayTxn(
    val nQrTxnId: String?,
    val instructionId: String?,
    /** Rupees as sent (JSON number -> BigDecimal, or a string). */
    val amount: Any?,
    val debitStatus: String?,
    val creditStatus: String?,
    val merchantBillNo: String?,
    val payerName: String?,
    val tranType: String?,
    val raw: Map<String, Any?>,
) {
    companion object {
        internal fun of(row: Map<String, Any?>): NepalPayTxn {
            fun s(k: String) = row[k]?.let(::jsString)
            return NepalPayTxn(
                nQrTxnId = s("nQrTxnId"), instructionId = s("instructionId"), amount = row["amount"], debitStatus = s("debitStatus"),
                creditStatus = s("creditStatus"), merchantBillNo = s("merchantBillNo"), payerName = s("payerName"),
                tranType = s("tranType"), raw = row,
            )
        }
    }
}

private const val NPR = 524
private val CREDIT_OK = setOf("000", "999", "DEFER")
private val NEPALPAY_BILL_NUMBER = Regex("^[A-Za-z0-9-]{1,25}$")

/** The exact string NCHL expects to be signed for a dynamic QR. */
fun nepalPayTokenString(
    acquirerId: String,
    merchantId: String,
    merchantCategoryCode: String,
    transactionCurrency: String,
    transactionAmount: String,
    billNumber: String,
    userId: String,
): String = listOf(acquirerId, merchantId, merchantCategoryCode, transactionCurrency, transactionAmount, billNumber, userId).joinToString(",")

/** What NCHL signs on a confirm-payment notification. The docs name the field payerMobileNumber; the sample sends payerMobile. */
fun nepalPayConfirmationString(n: Map<String, Any?>): String {
    fun v(k: String) = n[k]?.let(::jsString) ?: ""
    val mobile = if (n["payerMobileNumber"] != null) v("payerMobileNumber") else v("payerMobile")
    return listOf(v("merchantBillNo"), v("merchantId"), v("merchantName"), v("paymentRef"), v("channel"), mobile, v("sessionNo")).joinToString(",")
}

/**
 * Everything a STOMP client needs to watch one QR live: connect to [url], subscribe to [subscribe], then send [body]
 * as JSON ([Json.stringify]) to [send].
 */
data class NepalPayWebSocketRequest(
    val url: String,
    val subscribe: String,
    val send: String,
    /** merchant_id, request_id, username, api_token (RSA PKCS#1 v1.5 encrypted with nchlPublicKey, base64). */
    val body: Map<String, String>,
)

class NepalPay(val config: NepalPayConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.NEPALPAY

    private val http = Http(id, transport)
    private val base = config.baseUrl
        ?: if (config.env == Environment.SANDBOX) "https://devopennpi.connectips.com" else "https://opennpi.connectips.com"

    private class CachedToken(val token: String, val untilMs: Long)

    @Volatile
    private var cached: CachedToken? = null

    private suspend fun authHeader(): String {
        if (config.auth == NepalPayAuth.BASIC) return basicAuth(config.username, config.password)
        val clientId = config.clientId.orNullIfEmpty()
        val clientSecret = config.clientSecret.orNullIfEmpty()
        check(clientId != null && clientSecret != null) { "nepalpay: clientId/clientSecret required for auth OAUTH" }
        cached?.let { if (it.untilMs > System.currentTimeMillis()) return "Bearer ${it.token}" }
        val body = formEncode(linkedMapOf("grant_type" to "password", "username" to config.username, "password" to config.password))
        val res = http.request(
            "$base/oauth/token", "POST",
            linkedMapOf("Authorization" to basicAuth(clientId, clientSecret), "Content-Type" to "application/x-www-form-urlencoded"),
            body, config.timeout,
        )
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null || !jsTruthy(data["access_token"])) {
            throw PaymentException("NEPALPAY oauth failed: ${res.text.take(200)}", id, "unauthorized", res.status, res.data)
        }
        // JS `Number(expires_in) || 60`
        val ttl = data["expires_in"]?.let { jsString(it).trim().toDoubleOrNull() }?.takeIf { it != 0.0 && !it.isNaN() } ?: 60.0
        val token = CachedToken(jsString(data["access_token"]), System.currentTimeMillis() + (maxOf(ttl - 30, 5.0) * 1000).toLong())
        cached = token
        return "Bearer ${token.token}"
    }

    /**
     * Dynamic QR. billNumber = orderId (<= 25 chars). Persist `providerRef` (validationTraceId): verify() needs it.
     * returnUrl is unused: there is no redirect, the payer scans the QR from their own app.
     */
    override suspend fun initiate(input: InitiateInput): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (!NEPALPAY_BILL_NUMBER.matches(input.orderId)) {
            throw PaymentException("NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", id, "invalid_order_id")
        }
        val transactionAmount = paisaToRupees2dp(input.amountPaisa) // always 2 decimals
        val token = rsaSha256SignBase64(
            config.privateKey,
            nepalPayTokenString(
                acquirerId = config.acquirerId,
                merchantId = config.merchantId,
                merchantCategoryCode = config.merchantCategoryCode,
                transactionCurrency = NPR.toString(),
                transactionAmount = transactionAmount,
                billNumber = input.orderId,
                userId = config.username,
            ),
        )
        val body = linkedMapOf<String, Any?>(
            "pointOfInitialization" to 12,
            "acquirerId" to config.acquirerId,
            "merchantId" to config.merchantId,
            "merchantName" to config.merchantName.take(25),
            "merchantCategoryCode" to config.merchantCategoryCode.trim().toBigDecimalOrNull(), // JSON number, like TS Number(mcc)
            "merchantCountry" to "NP",
            "merchantCity" to config.merchantCity,
            "merchantPostalCode" to config.merchantPostalCode,
            "merchantLanguage" to "en",
            "transactionCurrency" to NPR,
            "transactionAmount" to transactionAmount,
            "valueOfConvenienceFeeFixed" to "0.00",
            "billNumber" to input.orderId,
            "storeLabel" to config.storeLabel,
            "terminalLabel" to (config.terminalLabel ?: "0"),
            "purposeOfTransaction" to input.description.ifEmpty { "Payment" }.take(25),
            "qrImage" to config.qrImage,
            "token" to token,
        )
        val res = http.request("$base/qr/generateQR", "POST", mapOf("Authorization" to authHeader()), body, config.timeout)
        val data = res.data.field("data").asJsonObject()
        if (res.data.field("responseCode") != "000" || data == null || !jsTruthy(data["qrString"]) || !jsTruthy(data["validationTraceId"])) {
            val code = res.data.field("responseCode")
                ?: (res.data.field("responses") as? List<*>)?.firstOrNull().field("responseCode")
                ?: "http_${res.status}"
            throw PaymentException("NEPALPAY generateQR failed: ${res.text.take(300)}", id, jsString(code), res.status, res.data)
        }
        return InitiateResult.Qr(
            qrString = jsString(data["qrString"]).trim(),
            qrImage = if (jsTruthy(data["qrImage"])) jsString(data["qrImage"]) else null,
            providerRef = jsString(data["validationTraceId"]),
            raw = res.data,
        )
    }

    /** Every payment made against one QR (a failed scan can be retried on the same QR). */
    suspend fun report(validationTraceId: String): List<NepalPayTxn> {
        val body = linkedMapOf("validationTraceId" to validationTraceId, "merchantId" to config.merchantId, "acquirerId" to config.acquirerId)
        val res = http.request(
            "$base/nQR/v1/merchanttxnreport", "POST", mapOf("Authorization" to authHeader()), body, config.timeout, retries = 2,
        )
        if (res.status == 401) throw PaymentException("NEPALPAY: 401 — wrong NPI username/password", id, "unauthorized", 401, res.data)
        val code = res.data.field("responseCode")?.let(::jsString) ?: ""
        if (code == "E010") return emptyList() // record not found
        if (code != "200" && code != "000") {
            throw PaymentException("NEPALPAY report failed: ${res.text.take(200)}", id, code.ifEmpty { "http_${res.status}" }, res.status, res.data)
        }
        val rows = res.data.field("responseBody") as? List<*> ?: return emptyList()
        return rows.mapNotNull { it.asJsonObject()?.let(NepalPayTxn::of) }
    }

    /** merchanttxnreport by validationTraceId: authoritative. */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val providerRef = input.providerRef
        if (providerRef.isNullOrEmpty()) {
            throw PaymentException("NEPALPAY verify needs providerRef (validationTraceId)", id, "missing_provider_ref")
        }
        val txns = report(providerRef)
        val payments = txns.filter { (it.tranType ?: "PMT") == "PMT" }
        val paid = payments.firstOrNull { it.debitStatus == "000" && it.creditStatus in CREDIT_OK }
        val pick = paid ?: payments.lastOrNull()
        val status = when {
            paid != null -> PaymentStatus.PAID
            pick == null -> PaymentStatus.NOT_FOUND
            pick.debitStatus == "000" -> PaymentStatus.UNKNOWN // debited but credit not confirmed: review
            else -> PaymentStatus.FAILED
        }
        return VerifyResult(
            provider = id,
            status = status,
            orderId = input.orderId,
            amountPaisa = pick?.amount?.let(::rupeesToPaisaValue),
            transactionId = pick?.nQrTxnId,
            raw = txns.map { it.raw },
        )
    }

    /** Your orderId from a confirm-payment notification (merchantBillNo = the billNumber you sent). */
    override fun orderIdFromCallback(params: Map<String, String>): String? =
        params["merchantBillNo"].orNullIfEmpty() ?: params["billNumber"].orNullIfEmpty()

    /**
     * Check a confirm-payment notification's signature with nchlPublicKey. NCHL doesn't say which key signs it, so
     * a false here is a reason to log and alert, not proof of forgery. Fulfil only after verify() either way.
     */
    fun verifyConfirmation(n: Map<String, Any?>): Boolean {
        val key = checkNotNull(config.nchlPublicKey) { "nepalpay: nchlPublicKey required to verify notifications" }
        val signature = n["signature"] as? String ?: return false
        return rsaSha256VerifyBase64(key, nepalPayConfirmationString(n), signature)
    }

    /**
     * Everything a STOMP client needs to watch one QR live (see [NepalPayWebSocketRequest]).
     * Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify().
     */
    fun webSocketRequest(validationTraceId: String): NepalPayWebSocketRequest {
        val url = config.wsUrl.orNullIfEmpty()
        val username = config.wsUsername.orNullIfEmpty()
        val apiToken = config.wsApiToken.orNullIfEmpty()
        val key = config.nchlPublicKey
        check(url != null && username != null && apiToken != null && key != null) {
            "nepalpay: wsUrl, wsUsername, wsApiToken and nchlPublicKey required for the WebSocket channel"
        }
        return NepalPayWebSocketRequest(
            url = url,
            subscribe = "/user/nqrws/check-txn-status",
            send = "/nqrws/check-txn-status",
            body = linkedMapOf(
                "merchant_id" to (config.terminalLabel ?: "0"),
                "request_id" to validationTraceId,
                "username" to username,
                "api_token" to rsaPkcs1EncryptBase64(key, apiToken),
            ),
        )
    }

    /**
     * Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification, ready for [Json.stringify].
     * The notification is a hint: call verify() before fulfilling.
     */
    fun confirmationResponse(txnDate: String, merchantBillNo: String, paymentRef: String, ok: Boolean = true): Map<String, String> {
        val status = if (ok) "SUCCESS" else "FAILED"
        val message = if (ok) "TRANSACTION SUCCESSFUL" else "TRANSACTION FAILED"
        val tokenString = listOf(txnDate, status, message, merchantBillNo, paymentRef).joinToString(",")
        return linkedMapOf(
            "txnDate" to txnDate,
            "status" to status,
            "message" to message,
            "merchantBillNo" to merchantBillNo,
            "paymentRef" to paymentRef,
            "signature" to rsaSha256SignBase64(config.privateKey, tokenString),
        )
    }
}
