/*
 * Fonepay — Web payment (redirect) + Dynamic QR. Port of scripts/ts/src/fonepay.ts.
 * Source: "Technical Specification Document (Fonepay Web Integration) v2.0" + Dynamic QR spec v1.1 (2024).
 *
 * Signatures: HMAC-SHA512(secretKey UTF-8, comma-joined values) as HEX. Compare case-insensitively.
 *   request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
 *   response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
 *   txnVerification  = username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>
 *   QR create        = amount,prn,merchantCode,remarks1,remarks2
 *   QR status        = prn,merchantCode
 */
package np.payments

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class FonepayConfig(
    val env: Environment,
    /** PID / merchant code (3–20 chars). Public dev sample: "NBQM". */
    val merchantCode: String,
    /** HMAC secret from the merchant profile page. Public dev sample: "a7e3512f5032480a83137793cb2021dc". */
    val secretKey: String,
    /** Merchant-panel login: required for txnVerification (recommended) and Dynamic QR. */
    val username: String? = null,
    val password: String? = null,
    /** Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank). */
    val paymentUrl: String? = null,
    val txnVerificationUrl: String? = null,
    val legacyVerifyUrl: String? = null,
    val qrBaseUrl: String? = null,
    val strictSignature: Boolean = true,
    val timeout: Duration = 15.seconds,
) {
    override fun toString() =
        "FonepayConfig(env=$env, merchantCode=$merchantCode, secretKey=***, username=$username, password=***, paymentUrl=$paymentUrl, " +
            "txnVerificationUrl=$txnVerificationUrl, legacyVerifyUrl=$legacyVerifyUrl, qrBaseUrl=$qrBaseUrl, strictSignature=$strictSignature, timeout=$timeout)"
}

data class FonepayInitiateExtras(val remarks2: String? = null)

data class FonepayQr(
    /** Render as a QR code. */
    val qrMessage: String,
    /** Listen for "paymentSuccess", then confirm with qrStatus() before fulfilling. */
    val webSocketUrl: String?,
    val raw: Any?,
)

private val FONEPAY_TXN_STATUS = mapOf("success" to PaymentStatus.PAID, "pending" to PaymentStatus.PENDING, "failed" to PaymentStatus.FAILED)
private const val FONEPAY_TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification"
private val FONEPAY_RESPONSE_DV_FIELDS = listOf("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT")
private val KATHMANDU: ZoneId = ZoneId.of("Asia/Kathmandu")
private val FONEPAY_DATE = DateTimeFormatter.ofPattern("MM/dd/yyyy", Locale.ROOT)

/** Uppercase hex HMAC-SHA512 over the comma-joined values. */
fun fonepayHmac(secret: String, values: List<String>): String =
    toHex(hmac(HmacAlgorithm.SHA_512, secret, values.joinToString(","))).uppercase()

/** MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats). */
fun fonepayDate(at: Instant = Instant.now()): String = FONEPAY_DATE.format(at.atZone(KATHMANDU))

class Fonepay(val config: FonepayConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.FONEPAY

    private val http = Http(id, transport)
    private val prod = config.env == Environment.PRODUCTION
    private val clientApi = if (prod) "https://clientapi.fonepay.com" else "https://dev-clientapi.fonepay.com"
    private val paymentUrl = config.paymentUrl ?: "$clientApi/api/merchantRequest"
    private val legacyVerifyUrl = config.legacyVerifyUrl ?: "$clientApi/api/merchantRequest/verificationMerchant"

    // Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on onboarding).
    private val merchantApi = if (prod) "https://merchantapi.fonepay.com" else "https://dev-merchantapi.fonepay.com"
    private val txnVerificationUrl = config.txnVerificationUrl ?: "$merchantApi/api/merchant/merchantDetailsForThirdParty/txnVerification"
    private val qrBaseUrl = config.qrBaseUrl ?: "$merchantApi/api/merchant/merchantDetailsForThirdParty"

    private fun sign(values: List<String>) = fonepayHmac(config.secretKey, values)

    private fun hasLogin() = !config.username.isNullOrEmpty() && !config.password.isNullOrEmpty()

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, FonepayInitiateExtras())

    /** Redirect URL for the Fonepay payment page. PRN = orderId (3–25 chars). Keep returnUrl (RU) <= 150 chars, no query string. */
    suspend fun initiate(input: InitiateInput, extras: FonepayInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (input.orderId.length < 3 || input.orderId.length > 25) {
            throw PaymentException("Fonepay PRN must be 3–25 chars", id, "invalid_order_id")
        }
        if (input.returnUrl.length > 150) throw PaymentException("Fonepay RU must be <= 150 chars", id, "invalid_return_url")
        val p = linkedMapOf(
            "PID" to config.merchantCode,
            "MD" to "P",
            "PRN" to input.orderId,
            "AMT" to paisaToRupees(input.amountPaisa), // rupees; the SAME string goes into DV
            "CRN" to "NPR",
            "DT" to fonepayDate(),
            "R1" to input.description.take(160).ifEmpty { "Payment" },
            "R2" to (extras.remarks2 ?: "N/A").take(50).ifEmpty { "N/A" },
            "RU" to input.returnUrl,
        )
        p["DV"] = sign(p.values.toList()) // raw (not URL-encoded) values, in PID,MD,PRN,AMT,CRN,DT,R1,R2,RU order
        return InitiateResult.Redirect(url = "$paymentUrl?${formEncode(p)}")
    }

    /** True only when the response DV is present and matches (case-insensitive). */
    fun callbackValid(params: Map<String, String>): Boolean {
        val dv = params["DV"]
        if (dv.isNullOrEmpty()) return false
        val expected = sign(FONEPAY_RESPONSE_DV_FIELDS.map { params[it] ?: "" })
        return safeEqual(expected, dv.uppercase())
    }

    /**
     * Authoritative check. Uses txnVerification when username/password are configured (works without a callback, so
     * the reconciliation job can use it). Otherwise falls back to the legacy GET verification, which needs UID + BC
     * from a DV-signed redirect.
     */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        // Callback params are trusted ONLY with a valid DV. A missing DV is treated exactly like a bad one,
        // otherwise anyone could send ?PRN=<id>&PS=false without a DV and force a "failed" outcome.
        val callback = input.callback
        var trusted: Map<String, String>? = null
        if (callback != null && callback.keys.any { it == "DV" || it in FONEPAY_RESPONSE_DV_FIELDS }) {
            if (callbackValid(callback)) {
                if (callback["PRN"] != input.orderId || callback["PID"] != config.merchantCode) {
                    throw PaymentException("Fonepay: callback does not match this attempt", id, "callback_mismatch", 400, callback)
                }
                trusted = callback
            } else if (config.strictSignature) {
                throw PaymentException("Fonepay: missing or invalid response DV", id, "invalid_signature", 400, callback)
            }
        }

        if (hasLogin()) {
            val r = txnVerification(input.orderId, input.amountPaisa)
            val requested = r["requestedAmount"]
            return VerifyResult(
                provider = id,
                status = FONEPAY_TXN_STATUS[jsString(r["paymentStatus"]).lowercase()] ?: PaymentStatus.UNKNOWN,
                orderId = input.orderId,
                amountPaisa = if (jsTruthy(requested)) rupeesToPaisaValue(requested) else null,
                transactionId = r["fonepayTraceId"]?.let(::jsString) ?: trusted?.get("UID"),
                raw = r,
            )
        }

        if (trusted != null && !trusted["UID"].isNullOrEmpty() && !trusted["BC"].isNullOrEmpty()) {
            val uid = trusted.getValue("UID")
            // Authentic (DV-verified) negative outcome from Fonepay.
            if (trusted["PS"] != "true" || trusted["RC"] != "successful") {
                val status = if (trusted["RC"] == "cancel") PaymentStatus.CANCELED else PaymentStatus.FAILED
                return VerifyResult(id, status, input.orderId, null, uid, trusted)
            }
            val text = legacyVerify(input.orderId, input.amountPaisa, uid, trusted.getValue("BC"))
            val rAmt = trusted["R_AMT"]
            return VerifyResult(
                provider = id,
                status = if (text.second) PaymentStatus.PAID else PaymentStatus.FAILED,
                orderId = input.orderId,
                amountPaisa = if (!rAmt.isNullOrEmpty()) rupeesToPaisa(rAmt) else null, // R_AMT = amount requested (DV-signed)
                transactionId = uid,
                raw = mapOf("callback" to trusted, "verification" to text.first),
            )
        }

        throw PaymentException(
            "Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured for txnVerification",
            id,
            "verify_unavailable",
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? = params["PRN"].orNullIfEmpty()

    private suspend fun txnVerification(prn: String, amountPaisa: Long): Map<String, Any?> {
        if (!hasLogin()) throw IllegalStateException("fonepay: username/password required for txnVerification")
        val username = config.username!!
        val password = config.password!!
        // Body is signed byte-for-byte; build it once and send exactly that string (format follows the spec example).
        val body = "{\"prn\": ${Json.quote(prn)},\"merchantCode\": ${Json.quote(config.merchantCode)},\"amount\": ${Json.quote(paisaToRupees(amountPaisa))}}"
        val auth = toHex(
            hmac(HmacAlgorithm.SHA_512, config.secretKey, listOf(username, password, "POST", "application/json", FONEPAY_TXN_RESOURCE, body).joinToString(",")),
        )
        val res = http.request(
            txnVerificationUrl,
            "POST",
            linkedMapOf("Authorization" to basicAuth(username, password), "auth" to auth, "Content-Type" to "application/json"),
            body,
            config.timeout,
            retries = 2,
        )
        val data = res.data.asJsonObject()
        if (res.status != 200 || data?.get("paymentStatus") !is String) {
            throw PaymentException("Fonepay txnVerification failed: ${res.text.take(200)}", id, "http_${res.status}", res.status, res.data)
        }
        return data
    }

    /** Legacy (2019) GET verification; needs UID + BC from the redirect. Returns (XML text, paid?). */
    private suspend fun legacyVerify(prn: String, amountPaisa: Long, uid: String, bankCode: String): Pair<String, Boolean> {
        val amt = paisaToRupees(amountPaisa)
        val dv = sign(listOf(config.merchantCode, amt, prn, bankCode, uid))
        val qs = formEncode(linkedMapOf("PRN" to prn, "PID" to config.merchantCode, "BID" to bankCode, "AMT" to amt, "UID" to uid, "DV" to dv))
        val res = http.request("$legacyVerifyUrl?$qs", headers = mapOf("Accept" to "application/xml"), timeout = config.timeout, retries = 2)
        // A 5xx / WAF page / HTML must never read as "not paid": throw so the attempt stays open.
        if (res.status != 200) {
            throw PaymentException("Fonepay verification HTTP ${res.status}", id, "upstream_error", res.status, res.text.take(500))
        }
        // Tag lookup on the raw text (no XML parser, so no XXE surface), as in the TS port.
        fun tag(t: String) = Regex("<$t>([^<]*)</$t>").find(res.text)?.groupValues?.get(1)
        val code = tag("response_code")
            ?: throw PaymentException("Fonepay verification: unparseable response", id, "malformed_response", res.status, res.text.take(500))
        return res.text to (code == "successful" && tag("success") == "true")
    }

    // ------------------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

    /** Create a dynamic QR. Render `qrMessage`; listen on `webSocketUrl` or poll qrStatus(). */
    suspend fun qrCreate(orderId: String, amountPaisa: Long, remarks1: String, remarks2: String = "N/A"): FonepayQr {
        requireLogin()
        assertPaisa(amountPaisa, id)
        val amount = paisaToRupees(amountPaisa)
        val body = linkedMapOf<String, Any?>(
            "amount" to amount,
            "remarks1" to remarks1,
            "remarks2" to remarks2,
            "prn" to orderId,
            "merchantCode" to config.merchantCode,
            "dataValidation" to sign(listOf(amount, orderId, config.merchantCode, remarks1, remarks2)).lowercase(),
            "username" to config.username,
            "password" to config.password,
        )
        val res = http.request("$qrBaseUrl/thirdPartyDynamicQrDownload", "POST", body = body, timeout = config.timeout)
        val data = res.data.asJsonObject()
        if (data == null || !jsTruthy(data["qrMessage"])) {
            val message = res.data.field("message")?.let(::jsString) ?: res.text.take(200)
            throw PaymentException("Fonepay QR create failed: $message", id, "http_${res.status}", res.status, res.data)
        }
        var ws = data["thirdpartyQrWebSocketUrl"]?.let(::jsString)
        // Fonepay has been seen returning a localhost host here; rewrite to the real socket host.
        if (ws != null && ws.contains("localhost")) {
            ws = ws.replaceFirst(Regex("^wss?://[^/]+"), if (prod) "wss://ws.fonepay.com" else "wss://dev-ws.fonepay.com")
        }
        return FonepayQr(jsString(data["qrMessage"]), ws, res.data)
    }

    /**
     * Poll QR payment status. Always call this after a websocket "paymentSuccess" message before fulfilling.
     * Pass the stored amount: the status response has none, but the QR was created server-side with it.
     */
    suspend fun qrStatus(orderId: String, amountPaisa: Long? = null): VerifyResult {
        requireLogin()
        val body = linkedMapOf<String, Any?>(
            "prn" to orderId,
            "merchantCode" to config.merchantCode,
            "dataValidation" to sign(listOf(orderId, config.merchantCode)).lowercase(),
            "username" to config.username,
            "password" to config.password,
        )
        val res = http.request("$qrBaseUrl/thirdPartyDynamicQrGetStatus", "POST", body = body, timeout = config.timeout, retries = 2)
        val status = res.data.field("paymentStatus") as? String
            ?: throw PaymentException("Fonepay QR status failed: ${res.text.take(200)}", id, "http_${res.status}", res.status, res.data)
        return VerifyResult(
            provider = id,
            status = FONEPAY_TXN_STATUS[status.lowercase()] ?: PaymentStatus.UNKNOWN,
            orderId = orderId,
            amountPaisa = amountPaisa,
            transactionId = res.data.field("fonepayTraceId")?.let(::jsString),
            raw = res.data,
        )
    }

    private fun requireLogin() {
        if (!hasLogin()) throw IllegalStateException("fonepay: username/password required for Dynamic QR")
    }
}
