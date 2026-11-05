/*
 * eSewa — https://developer.esewa.com.np. Port of scripts/ts/src/esewa.ts.
 *
 *  1. ePay v2 (web, also in a mobile WebView): signed form POST -> eSewa -> success_url?data=<base64 JSON>
 *     -> verify response signature -> status API (authoritative).
 *  2. Intent (mobile app-to-app): server books -> app opens deeplink -> eSewa POSTs callback_url -> status API.
 *
 * Signature (both): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in `signed_field_names` order.
 */
package np.payments

import java.math.BigDecimal
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class EsewaIntentCredentials(val productCode: String, val accessKey: String, val baseUrl: String? = null) {
    override fun toString() = "EsewaIntentCredentials(productCode=$productCode, accessKey=***, baseUrl=$baseUrl)"
}

data class EsewaConfig(
    val env: Environment,
    /** ePay product code. Sandbox: "EPAYTEST". */
    val productCode: String,
    /** ePay secret key. Watch for HTML-escaping (&amp;) when loading from config UIs. */
    val secretKey: String,
    /** Intent (mobile) credentials; only needed for intentBook() and friends. */
    val intent: EsewaIntentCredentials? = null,
    val formUrl: String? = null,
    val statusUrl: String? = null,
    /** Throw when the success-redirect signature doesn't verify (default true). Status API is checked regardless. */
    val strictSignature: Boolean = true,
    val timeout: Duration = 15.seconds,
) {
    override fun toString() =
        "EsewaConfig(env=$env, productCode=$productCode, secretKey=***, intent=$intent, formUrl=$formUrl, statusUrl=$statusUrl, strictSignature=$strictSignature, timeout=$timeout)"
}

/** Public eSewa sandbox credentials. */
object EsewaSandbox {
    const val PRODUCT_CODE = "EPAYTEST"
    const val SECRET_KEY = "8gBm/:&EnhH.1/q"
    const val INTENT_PRODUCT_CODE = "INTENT"
    /** Use as the raw string, NOT base64-decoded. */
    const val INTENT_ACCESS_KEY = "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ=="

    fun config(): EsewaConfig = EsewaConfig(
        env = Environment.SANDBOX,
        productCode = PRODUCT_CODE,
        secretKey = SECRET_KEY,
        intent = EsewaIntentCredentials(INTENT_PRODUCT_CODE, INTENT_ACCESS_KEY),
    )
}

/**
 * Optional breakdown, INCLUDED in amountPaisa. amountPaisa is always the TOTAL charged (what you store and pass to
 * verify()). eSewa's `amount` field = amountPaisa - tax - service - delivery.
 */
data class EsewaInitiateExtras(val taxPaisa: Long = 0, val serviceChargePaisa: Long = 0, val deliveryChargePaisa: Long = 0)

data class EsewaSuccess(val payload: Map<String, Any?>, val signatureValid: Boolean)

data class EsewaIntentBooking(
    val bookingId: String,
    val deeplink: String,
    val correlationId: String,
    /** "bookingId|correlationId": persist on the attempt. */
    val providerRef: String,
    val raw: Any?,
)

/** base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order. */
fun esewaSign(key: String, fields: Map<String, Any?>, order: List<String>): String {
    val message = order.joinToString(",") { f -> "$f=${fields[f]?.let(::jsString) ?: ""}" }
    return toBase64(hmac(HmacAlgorithm.SHA_256, key, message))
}

private val ESEWA_EPAY_STATUS = mapOf(
    "COMPLETE" to PaymentStatus.PAID,
    "PENDING" to PaymentStatus.PENDING,
    "AMBIGUOUS" to PaymentStatus.PENDING, // "payment is at halt state": keep re-checking
    "FULL_REFUND" to PaymentStatus.REFUNDED,
    "PARTIAL_REFUND" to PaymentStatus.PARTIALLY_REFUNDED,
    "NOT_FOUND" to PaymentStatus.NOT_FOUND, // session expired / never paid / wrong amount
    "CANCELED" to PaymentStatus.CANCELED,
)

private val ESEWA_INTENT_STATUS = mapOf(
    "SUCCESS" to PaymentStatus.PAID,
    "BOOKED" to PaymentStatus.PENDING,
    "PENDING" to PaymentStatus.PENDING,
    "FAILED" to PaymentStatus.FAILED,
    "CANCELED" to PaymentStatus.CANCELED,
    "REVERTED" to PaymentStatus.REFUNDED,
)

private val ESEWA_ORDER_ID = Regex("^[A-Za-z0-9-]+$")

class Esewa(val config: EsewaConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.ESEWA

    private val http = Http(id, transport)
    private val sandbox = config.env == Environment.SANDBOX
    private val formUrl = config.formUrl
        ?: if (sandbox) "https://rc-epay.esewa.com.np/api/epay/main/v2/form" else "https://epay.esewa.com.np/api/epay/main/v2/form"
    private val statusUrl = config.statusUrl
        ?: if (sandbox) "https://rc.esewa.com.np/api/epay/transaction/status/" else "https://esewa.com.np/api/epay/transaction/status/"

    // Production Intent host is issued by eSewa at go-live (pass intent.baseUrl).
    private val defaultIntentUrl = if (sandbox) "https://rc-checkout.esewa.com.np/api/client/intent/payment" else null
    private val secret = config.secretKey.replace("&amp;", "&")

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, EsewaInitiateExtras())

    /**
     * Form to auto-submit (application/x-www-form-urlencoded POST). Keep returnUrl/failureUrl free of query strings
     * (eSewa appends `?data=...`); put your attempt id in the PATH so failures can be matched too.
     */
    suspend fun initiate(input: InitiateInput, extras: EsewaInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (!ESEWA_ORDER_ID.matches(input.orderId)) {
            throw PaymentException("eSewa transaction_uuid allows only letters, digits and '-'", id, "invalid_order_id")
        }
        val tax = extras.taxPaisa
        val svc = extras.serviceChargePaisa
        val del = extras.deliveryChargePaisa
        val base = input.amountPaisa - tax - svc - del // amountPaisa is the TOTAL charged
        if (listOf(tax, svc, del).any { it < 0 || it > MAX_SAFE_PAISA } || base <= 0) {
            throw PaymentException("eSewa: tax/charges must be non-negative paisa and less than the total", id, "invalid_amount")
        }
        // Format ONCE and use the same strings in the form and in the signature ("110" vs "110.0" -> ES104).
        val fields = linkedMapOf(
            "amount" to paisaToRupees(base),
            "tax_amount" to paisaToRupees(tax),
            "product_service_charge" to paisaToRupees(svc),
            "product_delivery_charge" to paisaToRupees(del),
            "total_amount" to paisaToRupees(input.amountPaisa),
            "transaction_uuid" to input.orderId,
            "product_code" to config.productCode,
            "success_url" to input.returnUrl,
            "failure_url" to (input.failureUrl ?: input.returnUrl),
            "signed_field_names" to "total_amount,transaction_uuid,product_code",
        )
        fields["signature"] = esewaSign(secret, fields, listOf("total_amount", "transaction_uuid", "product_code"))
        return InitiateResult.Form(action = formUrl, fields = fields)
    }

    /** Decode + verify the base64 `data` param from success_url. Does NOT prove payment; call verify(). */
    fun parseSuccess(data: String): EsewaSuccess {
        val text: String
        val parsed: Any?
        try {
            text = decodeUtf8Strict(fromBase64(data))
            parsed = Json.parse(text)
        } catch (e: IllegalArgumentException) {
            throw PaymentException("eSewa: success data is not base64 JSON", id, "malformed_callback", 400, data, e)
        } catch (e: CharacterCodingException) {
            throw PaymentException("eSewa: success data is not base64 JSON", id, "malformed_callback", 400, data, e)
        }
        val payload = parsed.asJsonObject()
        val names = payload?.get("signed_field_names") as? String
            ?: throw PaymentException("eSewa: malformed success payload", id, "malformed_callback", 400, parsed)
        val order = names.split(",").map { it.trim() }
        val fields = order.associateWith { rawValue(text, payload, it) }
        val signature = payload["signature"] as? String
        var ok = signature != null && safeEqual(esewaSign(secret, fields, order), signature)
        // eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed. Try both.
        val total = fields["total_amount"]
        if (!ok && signature != null && total != null && total.contains(',')) {
            ok = safeEqual(esewaSign(secret, fields + ("total_amount" to total.replace(",", "")), order), signature)
        }
        return EsewaSuccess(payload, ok)
    }

    /**
     * Authoritative check via the status API. If `callback["data"]` is present (success redirect) its signature is
     * verified too. amountPaisa MUST be the TOTAL you charged: eSewa returns NOT_FOUND for a wrong total.
     */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        var signatureValid: Boolean? = null
        val data = input.callback?.get("data")
        if (!data.isNullOrEmpty()) {
            val parsed = parseSuccess(data)
            signatureValid = parsed.signatureValid
            if (parsed.payload["transaction_uuid"] != input.orderId || parsed.payload["product_code"] != config.productCode) {
                throw PaymentException("eSewa: callback does not match this attempt", id, "callback_mismatch", 400, parsed.payload)
            }
            if (!parsed.signatureValid && config.strictSignature) {
                throw PaymentException("eSewa: invalid response signature", id, "invalid_signature", 400, parsed.payload)
            }
        }
        val s = statusCheck(input.orderId, input.amountPaisa)
        val total = s["total_amount"]
        return VerifyResult(
            provider = id,
            status = ESEWA_EPAY_STATUS[jsString(s["status"])] ?: PaymentStatus.UNKNOWN,
            orderId = input.orderId,
            amountPaisa = if (total is String || total is Number) rupeesToPaisaValue(total) else null,
            transactionId = s["ref_id"]?.let(::jsString),
            raw = mapOf("status" to s, "signatureValid" to signatureValid),
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? {
        val data = params["data"]
        if (!data.isNullOrEmpty()) {
            return try {
                base64Json(data).asJsonObject()?.get("transaction_uuid")?.let(::jsString).orNullIfEmpty()
            } catch (e: IllegalArgumentException) {
                null
            }
        }
        // From your path param on failure_url.
        return params["orderId"].orNullIfEmpty() ?: params["order_id"].orNullIfEmpty() ?: params["transaction_uuid"].orNullIfEmpty()
    }

    private suspend fun statusCheck(orderId: String, amountPaisa: Long): Map<String, Any?> {
        val qs = formEncode(
            linkedMapOf("product_code" to config.productCode, "total_amount" to paisaToRupees(amountPaisa), "transaction_uuid" to orderId),
        )
        val res = http.request("$statusUrl?$qs", timeout = config.timeout, retries = 2)
        val body = res.data.asJsonObject()
        if (res.status != 200 || body == null || !body.containsKey("status")) {
            throw PaymentException("eSewa status check failed: ${errorMessage(res)}", id, errorCode(res), res.status, res.data)
        }
        return body
    }

    // ------------------------------------------------------------------ Intent (mobile app-to-app)

    /**
     * Book an Intent payment. Open `deeplink` in the app; persist [EsewaIntentBooking.providerRef] on the attempt.
     * Use whole-rupee amounts: decimal amount signing for Intent is not documented.
     */
    suspend fun intentBook(
        orderId: String,
        amountPaisa: Long,
        /** Server-to-server POST from eSewa. */
        callbackUrl: String,
        /** Where the user lands after paying. */
        redirectUrl: String,
        /** snake_case keys; shown to the user. */
        properties: Map<String, String>? = null,
    ): EsewaIntentBooking {
        val intent = requireIntent()
        assertPaisa(amountPaisa, id)
        val amount = BigDecimal(paisaToRupees(amountPaisa)).stripTrailingZeros() // JSON number: 100 / 100.5
        val amountText = amount.toPlainString()
        val body = linkedMapOf<String, Any?>(
            "product_code" to intent.productCode,
            "amount" to BigDecimal(amountText),
            "transaction_uuid" to orderId,
            "signed_field_names" to "product_code,amount,transaction_uuid",
            "signature" to esewaSign(
                intent.accessKey,
                mapOf("product_code" to intent.productCode, "amount" to amountText, "transaction_uuid" to orderId),
                listOf("product_code", "amount", "transaction_uuid"),
            ),
            "callback_url" to callbackUrl,
            "redirect_url" to redirectUrl,
            "properties" to (properties ?: mapOf("remarks" to orderId)),
        )
        val res = http.request("${intent.baseUrl}/book", "POST", body = body, timeout = config.timeout)
        val d = res.data.field("data").asJsonObject()
        if (d == null || !jsTruthy(d["booking_id"])) throw intentError("book", res)
        val bookingId = jsString(d["booking_id"])
        val correlationId = jsString(d["correlation_id"] ?: "")
        return EsewaIntentBooking(bookingId, jsString(d["deeplink"] ?: ""), correlationId, "$bookingId|$correlationId", res.data)
    }

    /**
     * Authoritative Intent status. providerRef = "bookingId|correlationId" stored at booking. Pass the stored amount:
     * the status response has none, but the amount was signed at booking.
     */
    suspend fun intentVerify(orderId: String, providerRef: String, amountPaisa: Long? = null): VerifyResult {
        val intent = requireIntent()
        val parts = providerRef.split("|")
        val signed = linkedMapOf<String, Any?>("booking_id" to parts[0], "product_code" to intent.productCode, "correlation_id" to parts.getOrNull(1))
        val order = listOf("booking_id", "product_code", "correlation_id")
        val body = LinkedHashMap(signed.filterValues { it != null })
        body["signed_field_names"] = order.joinToString(",")
        body["signature"] = esewaSign(intent.accessKey, signed, order)
        val res = http.request("${intent.baseUrl}/status", "POST", body = body, timeout = config.timeout, retries = 2)
        val d = res.data.field("data").asJsonObject()
        if (d == null || !jsTruthy(d["status"])) throw intentError("status", res)
        if (jsTruthy(d["transaction_id"]) && d["transaction_id"] != orderId) {
            throw PaymentException("eSewa intent: status is for a different transaction", id, "callback_mismatch", 400, d)
        }
        // Status response has no amount: the amount was fixed and signed at booking time.
        return VerifyResult(
            provider = id,
            status = ESEWA_INTENT_STATUS[jsString(d["status"])] ?: PaymentStatus.UNKNOWN,
            orderId = orderId,
            amountPaisa = amountPaisa,
            transactionId = d["reference_code"]?.let(::jsString),
            raw = res.data,
        )
    }

    /** Cancel a booking that hasn't completed (e.g. user abandoned). Returns eSewa's parsed response. */
    suspend fun intentCancel(providerRef: String): Any? {
        val intent = requireIntent()
        val fields = linkedMapOf<String, Any?>("booking_id" to providerRef.split("|")[0], "product_code" to intent.productCode)
        val order = listOf("booking_id", "product_code")
        val body = LinkedHashMap(fields)
        body["signed_field_names"] = order.joinToString(",")
        body["signature"] = esewaSign(intent.accessKey, fields, order)
        return http.request("${intent.baseUrl}/cancel", "POST", body = body, timeout = config.timeout).data
    }

    /**
     * Verify the signature on eSewa's Intent callback POST body (parsed JSON). Still call intentVerify() before fulfilling.
     * Prefer the raw-body overload: a parsed map can only be checked in the JS String(v) form (100.0 signs as "100").
     */
    fun intentCallbackValid(body: Map<String, Any?>): Boolean = intentCallbackValid(body, null)

    /**
     * Same, from the RAW request body: numbers are then also checked exactly as eSewa sent them ("100.0"),
     * not only in the String(v) form ("100"). Non-JSON or non-object bodies are invalid.
     */
    fun intentCallbackValid(rawBody: String): Boolean {
        val payload = try {
            Json.parse(rawBody).asJsonObject()
        } catch (e: IllegalArgumentException) {
            null
        } ?: return false
        return intentCallbackValid(payload, rawBody)
    }

    private fun intentCallbackValid(body: Map<String, Any?>, text: String?): Boolean {
        val intent = requireIntent()
        val names = body["signed_field_names"] as? String ?: return false
        val signature = body["signature"] as? String ?: return false
        val order = names.split(",").map { it.trim() }
        val asString = order.associateWith { jsString(body[it] ?: "") }
        if (safeEqual(esewaSign(intent.accessKey, asString, order), signature)) return true
        if (text == null) return false
        val exact = order.associateWith { rawValue(text, body, it) }
        return exact != asString && safeEqual(esewaSign(intent.accessKey, exact, order), signature)
    }

    private fun intentError(op: String, res: HttpResult): PaymentException =
        PaymentException("eSewa intent $op failed: ${errorMessage(res)}", id, errorCode(res), res.status, res.data)

    /** Error text from an eSewa error body: docs say `error_message`, the live Intent sandbox sends `errorMessage`. */
    private fun errorMessage(res: HttpResult): String =
        (res.data.field("error_message") ?: res.data.field("errorMessage"))?.let(::jsString) ?: res.text.take(200)

    /** `esewa_<code>` when the body carries a code, else `http_<status>`. */
    private fun errorCode(res: HttpResult): String =
        res.data.field("code")?.let { "esewa_${jsString(it)}" } ?: "http_${res.status}"

    /** Like [decodeUtf8], but invalid UTF-8 throws instead of becoming U+FFFD (TextDecoder `fatal: true`). */
    private fun decodeUtf8Strict(bytes: ByteArray): String {
        val s = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
        return if (s.startsWith('\uFEFF')) s.substring(1) else s
    }

    private fun requireIntent(): EsewaIntentCredentials {
        val intent = config.intent ?: throw IllegalStateException("eSewa: configure `intent` credentials to use Intent payments")
        val baseUrl = intent.baseUrl ?: defaultIntentUrl
            ?: throw IllegalStateException("eSewa: production Intent baseUrl is issued by eSewa at go-live; set intent.baseUrl")
        return intent.copy(baseUrl = baseUrl)
    }

    /** Exact text of a field as eSewa sent it, so numbers keep their formatting ("1000.0" stays "1000.0"). */
    private fun rawValue(text: String, payload: Map<String, Any?>, field: String): String {
        val v = payload[field]
        if (v !is Number) return jsString(v ?: "")
        val m = Regex("\"${Regex.escape(field)}\"\\s*:\\s*(-?[0-9][0-9.eE+-]*)").find(text)
        return m?.groupValues?.get(1) ?: jsString(v)
    }
}
