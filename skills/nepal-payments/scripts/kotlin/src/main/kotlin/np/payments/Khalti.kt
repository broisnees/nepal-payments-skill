/*
 * Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/. Port of scripts/ts/src/providers/khalti/.
 *
 * Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
 *       -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".
 */
package np.payments

import java.math.BigDecimal
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class KhaltiConfig(
    /** "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com (production). */
    val secretKey: String,
    val env: Environment,
    /** Your site's public URL (required by Khalti). */
    val websiteUrl: String,
    val timeout: Duration = 15.seconds,
) {
    override fun toString() = "KhaltiConfig(secretKey=***, env=$env, websiteUrl=$websiteUrl, timeout=$timeout)"
}

data class KhaltiAmountBreakdown(val label: String, val amount: Long)

data class KhaltiProductDetail(val identity: String, val name: String, val totalPrice: Long, val quantity: Int, val unitPrice: Long)

data class KhaltiInitiateExtras(
    /** Must sum to amountPaisa or Khalti returns "Amount Breakdown mismatch". */
    val amountBreakdown: List<KhaltiAmountBreakdown>? = null,
    val productDetails: List<KhaltiProductDetail>? = null,
    /** Keys must start with "merchant_"; echoed back in the success payload. */
    val merchantExtras: Map<String, String> = emptyMap(),
)

private val KHALTI_STATUS = mapOf(
    "completed" to PaymentStatus.PAID,
    "pending" to PaymentStatus.PENDING,
    "initiated" to PaymentStatus.PENDING, // user hasn't paid yet; Khalti flips it to Expired after the link expires
    "refunded" to PaymentStatus.REFUNDED,
    "partially refunded" to PaymentStatus.PARTIALLY_REFUNDED,
    "expired" to PaymentStatus.EXPIRED,
    "user canceled" to PaymentStatus.CANCELED,
    "failed" to PaymentStatus.FAILED,
)

class Khalti(val config: KhaltiConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.KHALTI

    private val http = Http(id, transport)
    private val host = if (config.env == Environment.SANDBOX) "https://dev.khalti.com" else "https://khalti.com"
    private val base = "$host/api/v2"
    private val auth: Map<String, String>

    init {
        require(config.secretKey.isNotEmpty()) { "khalti: secretKey is required" }
        auth = mapOf("Authorization" to "Key " + config.secretKey.replace(Regex("^key\\s+", RegexOption.IGNORE_CASE), ""))
    }

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, KhaltiInitiateExtras())

    suspend fun initiate(input: InitiateInput, extras: KhaltiInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (input.amountPaisa < 1000) throw PaymentException("Khalti minimum is Rs 10 (1000 paisa)", id, "amount_too_low")
        for (key in extras.merchantExtras.keys) require(key.startsWith("merchant_")) { "khalti: merchant extra keys must start with \"merchant_\": $key" }
        val body = linkedMapOf<String, Any?>(
            "return_url" to input.returnUrl,
            "website_url" to config.websiteUrl,
            "amount" to input.amountPaisa, // integer paisa
            "purchase_order_id" to input.orderId,
            "purchase_order_name" to input.description.take(255),
        )
        input.customer?.let { c ->
            body["customer_info"] = linkedMapOf("name" to c.name, "email" to c.email, "phone" to c.phone).filterValues { it != null }
        }
        extras.amountBreakdown?.let { list -> body["amount_breakdown"] = list.map { mapOf("label" to it.label, "amount" to it.amount) } }
        extras.productDetails?.let { list ->
            body["product_details"] = list.map {
                linkedMapOf(
                    "identity" to it.identity, "name" to it.name, "total_price" to it.totalPrice,
                    "quantity" to it.quantity, "unit_price" to it.unitPrice,
                )
            }
        }
        body.putAll(extras.merchantExtras)
        // Trailing slash is REQUIRED: without it Khalti 301s and the POST body is lost. No retries: not idempotent.
        val res = http.request("$base/epayment/initiate/", "POST", auth, body, config.timeout)
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null || !jsTruthy(data["pidx"])) {
            throw PaymentException(khaltiErrorMessage(res.data), id, errorKey(res.data, res.status), res.status, res.data)
        }
        return InitiateResult.Redirect(
            url = jsString(data["payment_url"] ?: ""),
            providerRef = jsString(data["pidx"]), // PERSIST THIS: lookup needs it and there is no lookup-by-order-id
            expiresAt = data["expires_at"]?.let(::jsString),
            raw = res.data,
        )
    }

    override suspend fun verify(input: VerifyInput): VerifyResult {
        // Use the pidx stored at initiate time. The lookup response does not include purchase_order_id,
        // so trusting a pidx from the callback would let a payer replay another payment's pidx.
        val pidx = input.providerRef
        if (pidx.isNullOrEmpty()) throw PaymentException("khalti: stored pidx required for verify", id, "missing_pidx")
        val cbPidx = input.callback?.get("pidx")
        if (!cbPidx.isNullOrEmpty() && cbPidx != pidx) {
            throw PaymentException("khalti: callback pidx does not match stored pidx", id, "pidx_mismatch", 400, input.callback)
        }

        // Lookup is a read; safe to retry.
        val res = http.request("$base/epayment/lookup/", "POST", auth, mapOf("pidx" to pidx), config.timeout, retries = 2)
        val data = res.data.asJsonObject()

        // Expired / User canceled come back as HTTP 400 WITH a normal body: parse, don't throw.
        val status = data?.get("status")
        if (status is String) {
            val total = data["total_amount"]
            return VerifyResult(
                provider = id,
                status = KHALTI_STATUS[status.lowercase()] ?: PaymentStatus.UNKNOWN,
                orderId = input.orderId,
                amountPaisa = if (total is BigDecimal) integralLongOrNull(total) else null,
                transactionId = data["transaction_id"]?.let(::jsString),
                raw = res.data,
            )
        }
        if (res.status == 404 || data?.get("detail") == "Not found.") {
            return VerifyResult(id, PaymentStatus.NOT_FOUND, input.orderId, null, null, res.data)
        }
        throw PaymentException(khaltiErrorMessage(res.data), id, errorKey(res.data, res.status), res.status, res.data)
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? = params["purchase_order_id"].orNullIfEmpty()

    /**
     * Refund a completed transaction (transaction_id from lookup). Full refund when amountPaisa is null.
     * `mobile` is required for payments made via bank/e-banking. Khalti's docs say partial refund `amount` is paisa
     * but their example shows "50.00": confirm the unit in sandbox before relying on partial refunds.
     */
    suspend fun refund(transactionId: String, amountPaisa: Long? = null, mobile: String? = null): Any? {
        val body = linkedMapOf<String, Any?>()
        if (amountPaisa != null) {
            assertPaisa(amountPaisa, id)
            body["amount"] = amountPaisa
        }
        if (!mobile.isNullOrEmpty()) body["mobile"] = mobile
        val url = "$host/api/merchant-transaction/${encodeURIComponent(transactionId)}/refund/"
        val res = http.request(url, "POST", auth, body, config.timeout)
        if (res.status != 200) {
            throw PaymentException(khaltiErrorMessage(res.data), id, errorKey(res.data, res.status), res.status, res.data)
        }
        return res.data
    }

    private fun errorKey(data: Any?, status: Int): String {
        if (status == 401) return "unauthorized"
        val key = data.field("error_key")
        return if (jsTruthy(key)) jsString(key) else "http_$status"
    }

    private fun khaltiErrorMessage(data: Any?): String {
        val obj = data.asJsonObject() ?: return "Khalti error: ${jsString(data).take(200)}"
        if (jsTruthy(obj["detail"])) return "Khalti: ${jsString(obj["detail"])}"
        val fields = obj.entries
            .filter { it.key != "error_key" && it.key != "status_code" }
            .map { (k, v) -> "$k: " + if (v is List<*>) v.joinToString(" ") { if (it == null) "" else jsString(it) } else jsString(v) }
        return "Khalti: " + fields.joinToString("; ").ifEmpty { "unknown error" }
    }
}

/** BigDecimal -> Long when it is an integer in Long range, else null (never expands huge exponents). */
internal fun integralLongOrNull(v: BigDecimal): Long? {
    if (v.abs() > BigDecimal.valueOf(Long.MAX_VALUE)) return null
    return try {
        v.longValueExact()
    } catch (e: ArithmeticException) {
        null
    }
}
