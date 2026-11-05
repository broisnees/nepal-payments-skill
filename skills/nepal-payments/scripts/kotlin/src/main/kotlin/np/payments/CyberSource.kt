/*
 * CyberSource Secure Acceptance Hosted Checkout — the card gateway most Nepali banks provision.
 * Port of scripts/ts/src/cybersource.ts. Secure Acceptance is being sunset in favour of Unified Checkout
 * (see references/cybersource.md); it still works.
 *
 * Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over `signed_field_names` order.
 */
package np.payments

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class CyberSourceTransactionType(val wire: String) {
    /** auth + capture (typical). */
    SALE("sale"),
    /** capture later via Business Center / API. */
    AUTHORIZATION("authorization"),
}

data class CyberSourceConfig(
    val env: Environment,
    val profileId: String,
    val accessKey: String,
    val secretKey: String,
    val transactionType: CyberSourceTransactionType = CyberSourceTransactionType.SALE,
    val currency: String = "NPR",
    val locale: String = "en-us",
    /** Set when you host the receipt page yourself and want to override the profile's URL per request. */
    val useReturnUrlOverride: Boolean = false,
) {
    override fun toString() =
        "CyberSourceConfig(env=$env, profileId=$profileId, accessKey=***, secretKey=***, transactionType=$transactionType, currency=$currency, locale=$locale, useReturnUrlOverride=$useReturnUrlOverride)"
}

data class BillTo(
    val forename: String,
    val surname: String,
    val email: String,
    val addressLine1: String,
    val city: String,
    /** ISO 3166 alpha-2, e.g. "NP". */
    val country: String,
    val phone: String? = null,
    /** Required only for US/CA. */
    val postalCode: String? = null,
    /** Required only for US/CA. */
    val state: String? = null,
)

/** billTo is required for sale/authorization. merchantDefinedData: index -> value (no PII allowed). */
data class CyberSourceInitiateExtras(val billTo: BillTo, val merchantDefinedData: Map<Int, String> = emptyMap())

fun cybersourceSign(secretKey: String, fields: Map<String, String>): String {
    val names = (fields["signed_field_names"] ?: throw IllegalArgumentException("signed_field_names missing")).split(",")
    val message = names.joinToString(",") { "$it=${fields[it] ?: ""}" }
    return toBase64(hmac(HmacAlgorithm.SHA_256, secretKey, message))
}

private val SIGNED_DATE_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT).withZone(ZoneOffset.UTC)

/** UTC "yyyy-MM-dd'T'HH:mm:ss'Z'". Keep the server clock NTP-synced. */
fun signedDateTime(at: Instant = Instant.now()): String = SIGNED_DATE_TIME.format(at)

/**
 * ACCEPT -> paid (for "sale"; pending for authorization); REVIEW -> pending; DECLINE / ERROR -> failed
 * (system errors 150/151/152 -> unknown: re-check, don't retry blindly); CANCEL -> canceled.
 */
private fun mapDecision(decision: String?, reasonCode: String?, txnType: String): PaymentStatus = when (decision?.uppercase()) {
    "ACCEPT" -> if (txnType.startsWith("authorization")) PaymentStatus.PENDING else PaymentStatus.PAID
    "REVIEW" -> PaymentStatus.PENDING
    "DECLINE", "ERROR" -> if (reasonCode in setOf("150", "151", "152")) PaymentStatus.UNKNOWN else PaymentStatus.FAILED
    "CANCEL" -> PaymentStatus.CANCELED
    else -> PaymentStatus.UNKNOWN
}

class CyberSource(val config: CyberSourceConfig) : PaymentAdapter {
    override val id: ProviderId = ProviderId.CYBERSOURCE

    private val host = if (config.env == Environment.SANDBOX) "https://testsecureacceptance.cybersource.com" else "https://secureacceptance.cybersource.com"

    /** Always throws: CyberSource needs billTo. Use initiate(input, CyberSourceInitiateExtras(billTo)). */
    override suspend fun initiate(input: InitiateInput): InitiateResult =
        throw IllegalArgumentException("cybersource: billTo is required; call initiate(input, CyberSourceInitiateExtras(billTo = ...))")

    /** Form POST to /pay. orderId -> transaction_uuid AND reference_number (both <= 50 chars). */
    suspend fun initiate(input: InitiateInput, extras: CyberSourceInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (input.orderId.length > 50) throw PaymentException("CyberSource ids must be <= 50 chars", id, "invalid_order_id")
        val b = extras.billTo
        val fields = linkedMapOf(
            "access_key" to config.accessKey,
            "profile_id" to config.profileId,
            "transaction_uuid" to input.orderId,
            "signed_date_time" to signedDateTime(),
            "locale" to config.locale,
            "transaction_type" to config.transactionType.wire,
            "reference_number" to input.orderId,
            "amount" to paisaToRupees2dp(input.amountPaisa), // "1500.00"
            "currency" to config.currency,
            "bill_to_forename" to b.forename,
            "bill_to_surname" to b.surname,
            "bill_to_email" to b.email,
            "bill_to_address_line1" to b.addressLine1,
            "bill_to_address_city" to b.city,
            "bill_to_address_country" to b.country,
        )
        if (!b.phone.isNullOrEmpty()) fields["bill_to_phone"] = b.phone
        if (!b.postalCode.isNullOrEmpty()) fields["bill_to_address_postal_code"] = b.postalCode
        if (!b.state.isNullOrEmpty()) fields["bill_to_address_state"] = b.state
        if (config.useReturnUrlOverride) {
            fields["override_custom_receipt_page"] = input.returnUrl
            if (!input.failureUrl.isNullOrEmpty()) fields["override_custom_cancel_page"] = input.failureUrl
        }
        for ((i, v) in extras.merchantDefinedData.toSortedMap()) fields["merchant_defined_data$i"] = v // no PII allowed
        val signedNames = fields.keys.toList() + listOf("unsigned_field_names", "signed_field_names")
        fields["unsigned_field_names"] = ""
        fields["signed_field_names"] = signedNames.joinToString(",")
        fields["signature"] = cybersourceSign(config.secretKey, fields)
        return InitiateResult.Form(action = "$host/pay", fields = fields)
    }

    /**
     * Secure Acceptance has no simple status API: the signed response POST IS the proof. Pass the POST body as
     * `callback` (receipt page or, better, the Merchant POST URL). For reconciliation without a callback, use the
     * REST Transaction Search via the official SDK (references/cybersource.md).
     */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val callback = input.callback ?: throw PaymentException(
            "CyberSource SA: verification needs the signed response POST; use REST transaction search for reconciliation",
            id,
            "verify_unavailable",
        )
        if (!responseValid(callback)) {
            throw PaymentException("CyberSource: invalid response signature — treat as malicious", id, "invalid_signature", 400)
        }
        val p = signedOnly(callback)
        if ((p["req_reference_number"].orNullIfEmpty() ?: p["req_transaction_uuid"]) != input.orderId) {
            throw PaymentException("CyberSource: response is for a different order", id, "callback_mismatch", 400, p)
        }
        val reqCurrency = p["req_currency"]
        if (!reqCurrency.isNullOrEmpty() && reqCurrency != config.currency) {
            throw PaymentException("CyberSource: currency mismatch", id, "currency_mismatch", 400, p)
        }
        // Signed-but-empty auth_amount falls back to req_amount. Reason 110 (partial approval) is caught by the amount guard.
        val paid = p["auth_amount"].orNullIfEmpty() ?: p["req_amount"].orNullIfEmpty()
        return VerifyResult(
            provider = id,
            status = mapDecision(p["decision"], p["reason_code"], p["req_transaction_type"] ?: config.transactionType.wire),
            orderId = input.orderId,
            amountPaisa = paid?.let(::rupeesToPaisa),
            transactionId = p["transaction_id"],
            raw = p,
        )
    }

    override fun orderIdFromCallback(params: Map<String, String>): String? =
        params["req_reference_number"].orNullIfEmpty() ?: params["req_transaction_uuid"].orNullIfEmpty()

    /** Verify a Secure Acceptance response POST (receipt page or Merchant POST URL). */
    fun responseValid(params: Map<String, String>): Boolean {
        val signature = params["signature"]
        if (params["signed_field_names"].isNullOrEmpty() || signature.isNullOrEmpty()) return false
        return safeEqual(cybersourceSign(config.secretKey, params), signature)
    }

    /** Only trust fields listed in the response's signed_field_names. */
    private fun signedOnly(params: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (n in (params["signed_field_names"] ?: "").split(",")) params[n]?.let { out[n] = it }
        return out
    }
}
