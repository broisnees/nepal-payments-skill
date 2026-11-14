/*
 * Nepal Payment Solution (NPS / NPX) OnePG. Port of scripts/ts/src/providers/nps/.
 * Source: "DEVELOPER GUIDELINES – API DOCUMENT – GATEWAY 2025" (given to merchants at onboarding).
 *
 * Auth: Basic base64(apiUsername:apiPassword) on every API call.
 * Signature: HMAC-SHA512(secretKey, values of payload keys sorted alphabetically (excluding Signature),
 *            concatenated with NO separator) as lowercase hex.
 *
 * Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> payer pays
 *       -> NPS GETs your Notification URL + browser returns to ResponseUrl -> CheckTransactionStatus (authoritative).
 */
package np.payments

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class NpsConfig(
    val env: Environment,
    val merchantId: String,
    val merchantName: String,
    val apiUsername: String,
    val apiPassword: String,
    val secretKey: String,
    val apiBaseUrl: String? = null,
    val gatewayUrl: String? = null,
    val timeout: Duration = 20.seconds,
) {
    override fun toString() =
        "NpsConfig(env=$env, merchantId=$merchantId, merchantName=$merchantName, apiUsername=$apiUsername, apiPassword=***, secretKey=***, apiBaseUrl=$apiBaseUrl, gatewayUrl=$gatewayUrl, timeout=$timeout)"
}

/** instrumentCode skips NPS's bank/wallet picker page. */
data class NpsInitiateExtras(val instrumentCode: String? = null)

data class NpsInstrument(
    val institutionName: String?,
    val instrumentName: String?,
    val instrumentCode: String?,
    /** MBanking, EBanking, CheckoutGateway (wallets) or checkoutcard. */
    val bankType: String?,
    val logoUrl: String?,
    val raw: Map<String, Any?>,
)

data class NpsServiceCharge(
    val amount: String?,
    val commissionType: String?,
    val chargeValue: String?,
    val totalChargeAmount: String?,
    val raw: Map<String, Any?>,
)

private val NPS_STATUS = mapOf(
    "success" to PaymentStatus.PAID,
    "fail" to PaymentStatus.FAILED,
    "failed" to PaymentStatus.FAILED,
    "pending" to PaymentStatus.PENDING,
)

/** Sorted-keys, no-separator HMAC-SHA512 (lowercase hex). */
fun npsSign(secretKey: String, payload: Map<String, String>): String {
    val message = payload.keys.filter { it != "Signature" }.sorted().joinToString("") { payload.getValue(it) }
    return toHex(hmac(HmacAlgorithm.SHA_512, secretKey, message))
}

class Nps(val config: NpsConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.NPS

    private val http = Http(id, transport)
    private val sandbox = config.env == Environment.SANDBOX
    private val api = config.apiBaseUrl ?: if (sandbox) "https://apisandbox.nepalpayment.com" else "https://apigateway.nepalpayment.com"
    private val gateway = config.gatewayUrl
        ?: if (sandbox) "https://gatewaysandbox.nepalpayment.com/Payment/Index" else "https://gateway.nepalpayment.com/Payment/Index"
    private val merchant = linkedMapOf("MerchantId" to config.merchantId, "MerchantName" to config.merchantName)

    /** Optional: list banks/wallets to show your own picker; pass the chosen InstrumentCode to initiate(). */
    suspend fun getInstruments(): List<NpsInstrument> {
        val r = call("GetPaymentInstrumentDetails", merchant, 2)
        if (r["code"] != "0") throw fail("GetPaymentInstrumentDetails", r)
        return (r["data"] as? List<*>).orEmpty().mapNotNull { it.asJsonObject() }.map { m ->
            fun s(k: String) = m[k]?.let(::jsString)
            NpsInstrument(s("InstitutionName"), s("InstrumentName"), s("InstrumentCode"), s("BankType"), s("LogoUrl"), m)
        }
    }

    /** Optional: NPS service charge for an amount + instrument. */
    suspend fun getServiceCharge(amountPaisa: Long, instrumentCode: String): NpsServiceCharge {
        val r = call("GetServiceCharge", merchant + mapOf("Amount" to paisaToRupees(amountPaisa), "InstrumentCode" to instrumentCode), 2)
        if (r["code"] != "0") throw fail("GetServiceCharge", r)
        val d = r["data"].asJsonObject().orEmpty()
        fun s(k: String) = d[k]?.let(::jsString)
        return NpsServiceCharge(s("Amount"), s("CommissionType"), s("ChargeValue"), s("TotalChargeAmount"), d)
    }

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, NpsInitiateExtras())

    /**
     * GetProcessId + gateway form (multipart/form-data). providerRef = ProcessId (persist it).
     * The Notification URL (webhook) is configured with NPS at onboarding, not per request.
     */
    suspend fun initiate(input: InitiateInput, extras: NpsInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        val amount = paisaToRupees(input.amountPaisa) // the SAME string in GetProcessId and the form
        val r = call("GetProcessId", merchant + mapOf("Amount" to amount, "MerchantTxnId" to input.orderId))
        val processId = r["data"].field("ProcessId")
        if (r["code"] != "0" || !jsTruthy(processId)) throw fail("GetProcessId", r)
        val fields = LinkedHashMap(merchant)
        fields["Amount"] = amount
        fields["MerchantTxnId"] = input.orderId
        fields["ProcessId"] = jsString(processId)
        fields["TransactionRemarks"] = input.description.take(100)
        fields["ResponseUrl"] = input.returnUrl
        if (!extras.instrumentCode.isNullOrEmpty()) fields["InstrumentCode"] = extras.instrumentCode
        return InitiateResult.Form(action = gateway, fields = fields, enctype = InitiateResult.MULTIPART, providerRef = jsString(processId))
    }

    /** CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API error. */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val r = call("CheckTransactionStatus", merchant + mapOf("MerchantTxnId" to input.orderId), 2)
        if (r["code"] != "0") {
            // error_code "3" = "Transaction not initialized yet" (payer never reached the gateway)
            if (errors(r).any { it["error_code"] == "3" }) {
                return VerifyResult(id, PaymentStatus.NOT_FOUND, input.orderId, null, null, r)
            }
            throw fail("CheckTransactionStatus", r)
        }
        val d = r["data"].asJsonObject().orEmpty()
        if (jsTruthy(d["MerchantTxnId"]) && d["MerchantTxnId"] != input.orderId) {
            throw PaymentException("NPS: status is for a different transaction", id, "callback_mismatch", 400, d)
        }
        return VerifyResult(
            provider = id,
            status = NPS_STATUS[jsString(d["Status"] ?: "").lowercase()] ?: PaymentStatus.UNKNOWN,
            orderId = input.orderId,
            amountPaisa = if (jsTruthy(d["Amount"])) rupeesToPaisaValue(d["Amount"]) else null, // excludes ServiceCharge
            transactionId = d["GatewayReferenceNo"]?.let(::jsString),
            raw = r,
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? = params["MerchantTxnId"].orNullIfEmpty()

    /**
     * Plain-text body for your Notification URL handler AFTER you've verified + recorded the payment:
     * "received" the first time, "already received" for repeats.
     */
    fun notificationResponse(alreadyProcessed: Boolean): String = if (alreadyProcessed) "already received" else "received"

    /**
     * Acknowledge a notification only once the attempt is final (references/nps.md): returns null while [current] is
     * still open, so the handler answers non-2xx and NPS keeps notifying. [wasFinal] = attempt was final before this call.
     */
    fun notificationAck(wasFinal: Boolean, current: AttemptStatus): String? =
        if (current in FINAL_STATUSES) notificationResponse(wasFinal) else null

    private suspend fun call(path: String, payload: Map<String, String>, retries: Int = 0): Map<String, Any?> {
        val body = LinkedHashMap<String, Any?>(payload)
        body["Signature"] = npsSign(config.secretKey, payload)
        val res = http.request(
            "$api/$path", "POST", mapOf("Authorization" to basicAuth(config.apiUsername, config.apiPassword)), body, config.timeout, retries,
        )
        if (res.status == 401) throw PaymentException("NPS: 401 — wrong API username/password", id, "unauthorized", 401)
        val data = res.data.asJsonObject()
        if (res.status != 200 || data == null || !data.containsKey("code")) {
            throw PaymentException("NPS $path failed: ${res.text.take(200)}", id, "http_${res.status}", res.status, res.data)
        }
        return data
    }

    private fun errors(r: Map<String, Any?>): List<Map<String, Any?>> = (r["errors"] as? List<*>).orEmpty().mapNotNull { it.asJsonObject() }

    private fun fail(path: String, r: Map<String, Any?>): PaymentException {
        val errs = errors(r)
        val messages = errs.joinToString("; ") { e -> e["error_message"]?.let(::jsString) ?: "" }
        val firstCode = errs.firstOrNull()?.get("error_code")
        return PaymentException(
            "NPS $path: ${messages.ifEmpty { jsString(r["message"] ?: "") }}",
            id,
            if (jsTruthy(firstCode)) "nps_${jsString(firstCode)}" else "nps_error",
            200,
            r,
        )
    }
}
