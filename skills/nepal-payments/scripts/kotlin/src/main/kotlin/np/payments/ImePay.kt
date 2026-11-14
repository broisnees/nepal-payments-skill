/*
 * IME Pay web checkout. Port of scripts/ts/src/providers/imepay/ (source: IME Pay's official WooCommerce + WHMCS plugins).
 * IME Pay merged into Khalti ("Khalti by IME", July 2025); prefer Khalti for new builds.
 *
 * Auth: Basic base64(username:password) + header `Module: base64(moduleName)`. No HMAC; callbacks are UNSIGNED,
 * so Recheck is the only proof of payment. Port 7979 must be reachable outbound.
 */
package np.payments

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class ImePayConfig(
    val env: Environment,
    val merchantCode: String,
    val username: String,
    val password: String,
    val module: String,
    val baseUrl: String? = null,
    val timeout: Duration = 20.seconds,
) {
    override fun toString() =
        "ImePayConfig(env=$env, merchantCode=$merchantCode, username=$username, password=***, module=$module, baseUrl=$baseUrl, timeout=$timeout)"
}

class ImePay(val config: ImePayConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.IMEPAY

    private val http = Http(id, transport)
    private val base = config.baseUrl
        ?: if (config.env == Environment.SANDBOX) "https://stg.imepay.com.np:7979" else "https://payment.imepay.com.np:7979"
    private val headers = linkedMapOf(
        "Authorization" to basicAuth(config.username, config.password),
        "Module" to toBase64(config.module.toByteArray(Charsets.UTF_8)),
    )

    /**
     * GetToken -> redirect to WebCheckout with a base64 payload. IME POSTs the result (ResponseCode, RefId,
     * TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl. providerRef = TokenId (persist it).
     */
    override suspend fun initiate(input: InitiateInput): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        val amount = paisaToRupees2dp(input.amountPaisa) // "100.00"
        val res = http.request(
            "$base/api/Web/GetToken", "POST", headers,
            linkedMapOf("MerchantCode" to config.merchantCode, "Amount" to amount, "RefId" to input.orderId), config.timeout,
        )
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null || !jsTruthy(data["TokenId"]) || jsString(data["ResponseCode"]) != "0") {
            val message = res.data.field("ResponseDescription")?.let(::jsString) ?: res.text.take(200)
            val code = res.data.field("ResponseCode")?.let(::jsString) ?: res.status.toString()
            throw PaymentException("IME Pay GetToken failed: $message", id, "imepay_$code", res.status, res.data)
        }
        val token = jsString(data["TokenId"])
        val payload = listOf(token, config.merchantCode, input.orderId, amount, "POST", input.returnUrl, input.failureUrl ?: input.returnUrl)
            .joinToString("|")
        return InitiateResult.Redirect(
            url = "$base/WebCheckout/Checkout?data=${encodeURIComponent(toBase64(payload.toByteArray(Charsets.UTF_8)))}",
            providerRef = token,
            raw = res.data,
        )
    }

    /** Recheck: authoritative. ResponseCode 0 = paid. Other codes are inconsistently documented: treated as pending. */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val token = input.providerRef
        if (token.isNullOrEmpty()) throw PaymentException("IME Pay: stored TokenId required for verify", id, "missing_token")
        val res = http.request(
            "$base/api/Web/Recheck", "POST", headers,
            linkedMapOf("MerchantCode" to config.merchantCode, "RefId" to input.orderId, "TokenId" to token), config.timeout, retries = 2,
        )
        val d = res.data.asJsonObject()
        if (res.status != 200 || d == null || !d.containsKey("ResponseCode")) {
            throw PaymentException("IME Pay Recheck failed: ${res.text.take(200)}", id, "http_${res.status}", res.status, res.data)
        }
        if (jsTruthy(d["RefId"]) && d["RefId"] != input.orderId) {
            throw PaymentException("IME Pay: Recheck is for a different RefId", id, "callback_mismatch", 400, d)
        }
        val tranAmount = d["TranAmount"]
        return VerifyResult(
            provider = id,
            // Non-zero codes disagree across sources (1 = failed vs pending), so never mark failed from them;
            // the reconciliation job escalates the attempt for human review at its cutoff.
            status = if (jsString(d["ResponseCode"]) == "0") PaymentStatus.PAID else PaymentStatus.PENDING,
            orderId = input.orderId,
            amountPaisa = if (tranAmount != null && tranAmount != "") rupeesToPaisaValue(tranAmount) else null,
            transactionId = if (jsTruthy(d["TransactionId"])) jsString(d["TransactionId"]) else null,
            raw = d,
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? = params["RefId"].orNullIfEmpty()
}
