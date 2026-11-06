/*
 * Hamro Pay Checkout (Hamro Patro's wallet): https://hamropay.com.np/checkout/developer/reference/
 * Port of scripts/ts/src/hamropay.ts. Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP
 * 000000) -> Client Credentials: merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives
 * the webhook signing secret.
 *
 * Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
 *       {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
 *
 * Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
 *   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
 *   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
 *   get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
 *   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
 * transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
 */
package np.payments

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class HamroPayConfig(
    val env: Environment,
    val merchantId: String,
    val clientId: String,
    val clientApiKey: String,
    val clientSecret: String,
    /** Signing secret shown when you save the webhook URL in the merchant portal. Needed for [HamroPay.verifyWebhook]. */
    val webhookSecret: String? = null,
    /** API host override. Default UAT https://uat-payclient.hamropatro.com, live https://payclient.hamropatro.com. */
    val apiBaseUrl: String? = null,
    /** Full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay issues the live host. */
    val gatewayUrl: String? = null,
    val timeout: Duration = 15.seconds,
) {
    override fun toString() =
        "HamroPayConfig(env=$env, merchantId=$merchantId, clientId=$clientId, clientApiKey=***, clientSecret=***, " +
            "webhookSecret=***, apiBaseUrl=$apiBaseUrl, gatewayUrl=$gatewayUrl, timeout=$timeout)"
}

data class HamroPayInitiateExtras(
    /** Form field "remarks" (<= 250 chars). Defaults to the description. */
    val remarks: String? = null,
    /** Sent with Create Session and echoed in the webhook. */
    val metadata: Map<String, String>? = null,
)

const val HAMROPAY_MIN_PAISA: Long = 1000
const val HAMROPAY_MAX_PAISA: Long = 5_000_000

private const val SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout"
private val HAMROPAY_TXN_ID = Regex("^[A-Za-z0-9-]{1,25}$")

private val HAMROPAY_STATUS = mapOf(
    "COMPLETED" to PaymentStatus.PAID,
    "FAILED" to PaymentStatus.FAILED,
    "PENDING" to PaymentStatus.PENDING,
    "PROCESSING" to PaymentStatus.PENDING,
    "NOT_INITIATED" to PaymentStatus.NOT_FOUND,
    "CANCELED" to PaymentStatus.CANCELED,
    "CANCELLED" to PaymentStatus.CANCELED,
)

/**
 * base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a value would let two
 * different tuples share a signature: refuse it instead.
 */
fun hamroPaySign(secret: String, values: List<String>): String {
    require(values.none { it.contains(',') }) { "hamropay: signed values must not contain commas" }
    return toBase64(hmac(HmacAlgorithm.SHA_512, secret, values.joinToString(",")))
}

/** Paisa as a JSON number in rupees, printed like JS (89.92, 1200.5, 100). */
internal fun rupeesNumber(paisa: Long): BigDecimal {
    val n = BigDecimal.valueOf(paisa, 2).stripTrailingZeros()
    return if (n.scale() < 0) n.setScale(0) else n
}

/** JS `Number.prototype.toFixed(digits)` for a finite double. */
private fun jsToFixed(d: Double, digits: Int): String {
    if (Math.abs(d) >= 1e21) return jsString(d)
    return BigDecimal(d).setScale(digits, RoundingMode.HALF_UP).toPlainString()
}

class HamroPay(val config: HamroPayConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.HAMROPAY

    private val http = Http(id, transport)
    private val api = (config.apiBaseUrl
        ?: if (config.env == Environment.SANDBOX) "https://uat-payclient.hamropatro.com" else "https://payclient.hamropatro.com")
        .removeSuffix("/")
    private val gateway = config.gatewayUrl ?: if (config.env == Environment.SANDBOX) SANDBOX_GATEWAY else null

    private suspend fun post(path: String, body: Map<String, Any?>, signed: List<String>, retries: Int = 0): Map<String, Any?> {
        val res = http.request(
            "$api$path", "POST",
            linkedMapOf(
                "Signature" to hamroPaySign(config.clientSecret, signed),
                "Client-Id" to config.clientId,
                "Client-API-Key" to config.clientApiKey,
                // The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on
                // the next call (Hamro Pay's own sample measured every second request failing on UAT).
                "Connection" to "close",
            ),
            body, config.timeout, retries,
        )
        val code = res.data.field("code")
        if (res.status == 401 || (code is BigDecimal && code.compareTo(BigDecimal(16)) == 0)) {
            throw PaymentException(
                "Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)", id, "unauthorized", res.status, res.data,
            )
        }
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null) {
            val msg = res.data.field("message") as? String ?: res.text.take(200)
            throw PaymentException(
                "Hamro Pay $path failed: $msg", id, if (code != null) "code_${jsString(code)}" else "http_${res.status}", res.status, res.data,
            )
        }
        return data
    }

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, HamroPayInitiateExtras())

    /**
     * Create Session, then the signed form for the gateway. merchantTxnId = orderId (<= 25 chars).
     * Persist providerRef (the sessionId). A session lives about 10 minutes.
     * A timeout here may still have created the session on Hamro Pay's side: retry with a NEW orderId.
     */
    suspend fun initiate(input: InitiateInput, extras: HamroPayInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (input.amountPaisa < HAMROPAY_MIN_PAISA || input.amountPaisa > HAMROPAY_MAX_PAISA) {
            throw PaymentException("Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", id, "invalid_amount")
        }
        if (!HAMROPAY_TXN_ID.matches(input.orderId)) {
            throw PaymentException("Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]", id, "invalid_order_id")
        }
        val gateway = this.gateway.orNullIfEmpty()
            ?: throw IllegalStateException("hamropay: gatewayUrl is required in production (Hamro Pay issues the live gateway host)")
        val transactionAmount = input.amountPaisa.toString() // signed and sent as the same string
        val name = input.description.ifEmpty { "Payment" }
        val body = linkedMapOf<String, Any?>(
            "merchantTxnId" to input.orderId,
            "merchantId" to config.merchantId,
            "transactionAmount" to transactionAmount,
            "successRedirectionUrl" to input.returnUrl,
            "failedRedirectionUrl" to (input.failureUrl ?: input.returnUrl),
            "productList" to listOf(linkedMapOf("name" to name, "description" to name, "price" to rupeesNumber(input.amountPaisa), "quantity" to 1)),
        )
        input.customer?.phone.orNullIfEmpty()?.let { body["phone_number"] = it }
        extras.metadata?.let { body["metadata"] = it }
        val session = post(
            "/v1/checkout/sessionId", body,
            listOf(input.orderId, transactionAmount, config.merchantId, config.clientId, config.clientApiKey),
        )
        val sessionId = session["sessionId"] as? String
        if (sessionId.isNullOrEmpty()) {
            throw PaymentException("Hamro Pay: Create Session returned no sessionId", id, "no_session", 200, session)
        }
        if (session["merchantId"] != null && session["merchantId"] != config.merchantId) {
            throw PaymentException("Hamro Pay: Create Session answered for a different merchantId", id, "merchant_mismatch", 200, session)
        }
        val token = hamroPaySign(
            config.clientSecret,
            listOf(config.merchantId, input.orderId, sessionId, transactionAmount, config.clientId, config.clientApiKey),
        )
        return InitiateResult.Form(
            action = gateway,
            fields = linkedMapOf(
                "merchant_id" to config.merchantId,
                "session_id" to sessionId,
                "token" to token,
                "merchant_transaction_id" to input.orderId,
                "remarks" to (extras.remarks ?: input.description).take(250),
            ),
            providerRef = sessionId,
        )
    }

    /** Get Transaction: authoritative. amount is rupees, and 0 until the payment finishes. */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val orderId = input.orderId
        val r = post(
            "/v1/checkout/transaction",
            linkedMapOf("merchantId" to config.merchantId, "merchantTxnId" to orderId),
            listOf(orderId, config.merchantId, config.clientId, config.clientApiKey),
            retries = 2,
        )
        // The reference names it merchantTransactionId; the live API answers merchantTxnId.
        val echoed = r["merchantTransactionId"] ?: r["merchantTxnId"]
        if (echoed != null && echoed != "" && jsString(echoed) != orderId) {
            throw PaymentException("Hamro Pay: transaction answer is for a different merchantTxnId", id, "id_mismatch", 200, r)
        }
        val status = HAMROPAY_STATUS[jsString(r["status"] ?: "").uppercase()] ?: PaymentStatus.UNKNOWN
        val amount = r["amount"]
        return VerifyResult(
            provider = id,
            status = status,
            orderId = orderId,
            amountPaisa = if (status == PaymentStatus.PAID && amount != null) rupeesToPaisaValue(amount) else null,
            transactionId = (r["trackingId"] as? String).orNullIfEmpty(),
            raw = r,
        )
    }

    /** Success and failure redirects carry ?MerchantTxnId=<your orderId>. */
    override fun orderIdFromCallback(params: Map<String, String>): String? =
        params["MerchantTxnId"].orNullIfEmpty() ?: params["merchantTxnId"].orNullIfEmpty()

    /**
     * Check a webhook's "Signature" header. Hamro Pay signs its own rendering of the amount (a double), which may be
     * "1200", "1200.0" or "1200.00", so every form of the PARSED number is tried. Fulfil only after verify().
     */
    fun verifyWebhook(body: Map<String, Any?>, signature: String?): Boolean {
        val secret = config.webhookSecret.orNullIfEmpty()
            ?: throw IllegalStateException("hamropay: webhookSecret required to verify webhooks")
        if (signature.isNullOrEmpty()) return false
        val amount = (body["amount"] as? Number)?.toDouble() ?: return false // JSON numbers only, like TS typeof "number"
        if (amount.isNaN() || amount.isInfinite()) return false
        val prefix = listOf(body["merchantTxnId"], body["merchantId"], body["status"]).map {
            if (it !is String || it.isEmpty() || it.contains(',')) return false
            it
        }
        val plain = jsString(amount)
        var ok = false
        for (a in linkedSetOf(plain, jsToFixed(amount, 2), "$plain.0", jsToFixed(amount, 1))) {
            if (safeEqual(hamroPaySign(secret, prefix + a), signature)) ok = true
        }
        return ok
    }
}
