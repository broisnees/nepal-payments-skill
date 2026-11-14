/*
 * GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure): https://getpay.global/web-integration/
 * Port of scripts/ts/src/providers/getpay/. Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid,
 * tid}), oprKey, insKey (blank when operator-hosted), the bundle URL and the base URL.
 *
 * Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
 *   -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
 *   -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
 *   -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.
 *
 * merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
 * only counts when the token's oprSecret matches YOUR oprKey and data.clientId is YOUR orderId.
 */
package np.payments

import java.math.BigDecimal
import java.net.URI
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class GetPayConfig(
    val env: Environment,
    /** Base64 {"institutionId","mid","tid"} from the bank. */
    val papInfo: String,
    /** Operator key from the bank. It also reaches the browser (GetPay's design); it is not a secret. */
    val oprKey: String,
    val insKey: String? = null,
    /** Your site origin, e.g. "https://shop.example". GetPay requires the callback URLs on this host. */
    val websiteDomain: String,
    val businessName: String,
    /** Logo shown on the checkout page (absolute URL). */
    val imageUrl: String,
    val currency: String = "NPR",
    val themeColor: String = "#5662FF",
    val bundleUrl: String? = null,
    val baseUrl: String? = null,
    val timeout: Duration = 20.seconds,
)

data class GetPayInitiateExtras(
    /** HTML shown beside the card form. Default: the description and amount, escaped. */
    val orderInformationUI: String? = null,
    val allowBillingAddressFields: Boolean = true,
)

/** The decoded return token. */
data class GetPayToken(val id: String, val oprSecret: String)

private const val GETPAY_BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"
private val GETPAY_REQUEST_ID = Regex("^[A-Za-z0-9-]{1,50}$")
private val NOT_FOUND = Regex("not found", RegexOption.IGNORE_CASE)

private val GETPAY_STATUS = mapOf(
    "SUCCESS" to PaymentStatus.PAID,
    "APPROVED" to PaymentStatus.PAID,
    "FAILED" to PaymentStatus.FAILED,
    "FAILURE" to PaymentStatus.FAILED,
    "DECLINED" to PaymentStatus.FAILED,
    "PENDING" to PaymentStatus.PENDING,
    "CANCELLED" to PaymentStatus.CANCELED,
    "CANCELED" to PaymentStatus.CANCELED,
)

/** base64(SHA-256(oprKey + transactionId)): the oprSecret GetPay puts in the return token. */
fun getPayOprSecret(oprKey: String, transactionId: String): String = toBase64(sha256(oprKey + transactionId))

/** Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret". */
fun getPayDecodeToken(token: String): GetPayToken? {
    val text = try {
        decodeUtf8(fromBase64(token))
    } catch (e: IllegalArgumentException) {
        return null
    }
    val j = try {
        Json.parse(text)
    } catch (e: JsonException) {
        val i = text.indexOf(':')
        return if (i > 0 && i < text.length - 1) GetPayToken(text.substring(0, i), text.substring(i + 1)) else null
    }
    val id = j.field("id") as? String
    val oprSecret = j.field("oprSecret") as? String
    return if (!id.isNullOrEmpty() && !oprSecret.isNullOrEmpty()) GetPayToken(id, oprSecret) else null
}

/** JS `new URL(url).origin` for http(s) URLs (default port dropped, scheme and host lowercased). */
private fun urlOrigin(url: String): String {
    val u = URI(url)
    val scheme = u.scheme?.lowercase()
    val host = u.host?.lowercase()
    require(scheme != null && host != null) { "invalid URL: $url" }
    val port = if (u.port == -1 || (scheme == "https" && u.port == 443) || (scheme == "http" && u.port == 80)) "" else ":${u.port}"
    return "$scheme://$host$port"
}

/** JSON for a <script> block: "<" escaped so "</script>" inside a value cannot close it. */
private fun scriptJson(value: Any?): String = Json.stringify(value).replace("<", "\\u003c")

class GetPay(val config: GetPayConfig, transport: HttpTransport = HttpTransport.Default) : PaymentAdapter {
    override val id: ProviderId = ProviderId.GETPAY

    private val http = Http(id, transport)
    private val base = (config.baseUrl ?: if (config.env == Environment.SANDBOX) {
        "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
    } else {
        "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
    }).removeSuffix("/")
    private val bundleUrl = config.bundleUrl ?: GETPAY_BUNDLE
    private val origin = urlOrigin(config.websiteDomain)

    private suspend fun call(path: String, body: Map<String, String>): Map<String, Any?>? {
        val res = http.request("$base/$path", "POST", emptyMap(), body, config.timeout, retries = 2)
        val d = res.data.asJsonObject()
        val status = d?.get("status") as? BigDecimal
        if (status != null && status.compareTo(BigDecimal.ONE.negate()) == 0 && NOT_FOUND.containsMatchIn(jsString(d["message"]))) {
            return null
        }
        val data = d?.get("data").asJsonObject()
        if (res.status != 200 || d == null || status == null || status.signum() != 0 || data == null) {
            val msg = res.data.field("message")?.let(::jsString) ?: res.text.take(200)
            throw PaymentException("GetPay $path failed: $msg", id, "http_${res.status}", res.status, res.data)
        }
        return data
    }

    override suspend fun initiate(input: InitiateInput): InitiateResult = initiate(input, GetPayInitiateExtras())

    /**
     * Options for the browser SDK. clientRequestId = orderId. returnUrl / failureUrl must be on websiteDomain and must
     * serve [returnPage] (the token can arrive in the #hash, which only the browser sees).
     */
    suspend fun initiate(input: InitiateInput, extras: GetPayInitiateExtras): InitiateResult {
        assertPaisa(input.amountPaisa, id)
        if (!GETPAY_REQUEST_ID.matches(input.orderId)) {
            throw PaymentException("GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]", id, "invalid_order_id")
        }
        val failUrl = input.failureUrl ?: input.returnUrl
        for (u in listOf(input.returnUrl, failUrl)) {
            if (urlOrigin(u) != origin) {
                throw PaymentException("GetPay callback $u must be on websiteDomain $origin", id, "invalid_callback_url")
            }
        }
        val c = input.customer ?: Customer()
        val orderInformationUI = extras.orderInformationUI
            ?: "<div style=\"font-family:sans-serif\"><h3>${escapeHtml(input.description)}</h3>" +
            "<p>${escapeHtml(config.currency)} ${paisaToRupees2dp(input.amountPaisa)}</p></div>"
        return InitiateResult.Sdk(
            scriptUrl = bundleUrl,
            options = linkedMapOf(
                "clientRequestId" to input.orderId,
                "papInfo" to config.papInfo,
                "oprKey" to config.oprKey,
                "insKey" to (config.insKey ?: ""),
                "websiteDomain" to origin,
                "baseUrl" to base,
                "price" to rupeesNumber(input.amountPaisa), // GetPay wants a number, not a string
                "currency" to config.currency,
                "businessName" to config.businessName,
                "imageUrl" to config.imageUrl,
                "themeColor" to config.themeColor,
                "allowBillingAddressFields" to extras.allowBillingAddressFields,
                "userInfo" to linkedMapOf(
                    "name" to (c.name ?: ""), "email" to (c.email ?: ""), "state" to "", "country" to "", "zipcode" to "", "city" to "", "address" to "",
                ),
                "prefill" to linkedMapOf(
                    "name" to !c.name.isNullOrEmpty(), "email" to !c.email.isNullOrEmpty(), "state" to false, "city" to false,
                    "address" to false, "zipcode" to false, "country" to false,
                ),
                "disableFields" to emptyMap<String, Any?>(),
                "callbackUrl" to linkedMapOf("successUrl" to input.returnUrl, "failUrl" to failUrl),
                "orderInformationUI" to orderInformationUI,
            ),
        )
    }

    /**
     * With callback["token"]: check oprSecret against oprKey, then merchant-status, then the transaction must carry
     * your orderId. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot prove the
     * transaction is yours, so a success there comes back UNKNOWN for manual review.
     */
    override suspend fun verify(input: VerifyInput): VerifyResult {
        val orderId = input.orderId
        val token = input.callback?.get("token")
        if (token.isNullOrEmpty()) {
            val s = statement(clientRequestId = orderId)
                ?: return VerifyResult(id, PaymentStatus.NOT_FOUND, orderId, null, null, null)
            val st = GETPAY_STATUS[jsString(s["status"] ?: "").uppercase()] ?: PaymentStatus.UNKNOWN
            return VerifyResult(
                provider = id,
                status = if (st == PaymentStatus.PAID) PaymentStatus.UNKNOWN else st,
                orderId = orderId,
                amountPaisa = s["saleTransactionAmount"]?.let(::rupeesToPaisaValue),
                transactionId = s["transactionId"] as? String,
                raw = s,
            )
        }
        val t = getPayDecodeToken(token)
            ?: throw PaymentException("GetPay: return token is not base64 {id, oprSecret}", id, "malformed_callback", 400)
        if (!safeEqual(getPayOprSecret(config.oprKey, t.id), t.oprSecret)) {
            throw PaymentException("GetPay: oprSecret does not match oprKey + id", id, "bad_signature", 400, mapOf("id" to t.id))
        }
        val d = status(t.id) ?: return VerifyResult(id, PaymentStatus.NOT_FOUND, orderId, null, t.id, null)
        if ((d["clientId"]?.let(::jsString) ?: "") != orderId) {
            throw PaymentException("GetPay: transaction belongs to a different clientRequestId", id, "id_mismatch", 400, d)
        }
        return VerifyResult(
            provider = id,
            status = GETPAY_STATUS[jsString(d["status"] ?: "").uppercase()] ?: PaymentStatus.UNKNOWN,
            orderId = orderId,
            amountPaisa = d["amount"]?.let(::rupeesToPaisaValue),
            transactionId = t.id,
            raw = d,
        )
    }

    /** merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks}; null if unknown. */
    suspend fun status(transactionId: String): Map<String, Any?>? =
        call("merchant-status", linkedMapOf("id" to transactionId, "papInfo" to config.papInfo))

    /** transaction-statement: payer, masked PAN, scheme, stan, crrn. Query by exactly one of transactionId or clientRequestId. */
    suspend fun statement(transactionId: String? = null, clientRequestId: String? = null): Map<String, Any?>? {
        require((transactionId == null) != (clientRequestId == null)) { "getpay: pass exactly one of transactionId or clientRequestId" }
        return call(
            "transaction-statement",
            if (transactionId != null) mapOf("transactionId" to transactionId) else mapOf("clientRequestId" to clientRequestId!!),
        )
    }

    /** The orderId is in YOUR return URL path (GetPay adds only the token); extract it from the route instead. */
    override fun orderIdFromCallback(params: Map<String, String>): String? =
        params["clientRequestId"].orNullIfEmpty() ?: params["orderId"].orNullIfEmpty()

    /** Page 1: loads the bundle and starts checkout; onSuccess opens [paymentPageUrl]. */
    fun checkoutPage(r: InitiateResult.Sdk, paymentPageUrl: String): String =
        """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title>
<script defer src="${escapeHtml(r.scriptUrl)}"></script></head><body><div id="checkout" hidden></div><noscript>JavaScript is required to pay by card.</noscript>
<script>window.addEventListener("load",function(){var o=${scriptJson(r.options)};o.onSuccess=function(){location.href=${scriptJson(paymentPageUrl)}};o.onError=function(e){document.body.insertAdjacentHTML("beforeend","<p>Card checkout could not start. Please try again.</p>");console.error(e)};new GetPay(o).initialize()});</script></body></html>"""

    /** Page 2: GetPay renders the card form into #checkout. */
    fun paymentPage(): String =
        """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay by card</title>
<script defer src="${escapeHtml(bundleUrl)}"></script></head><body><div id="checkout"></div></body></html>"""

    /**
     * Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the query or the
     * #hash, and send it to [verifyUrl] as ?token=. Your server then calls verify() with callback["token"].
     */
    fun returnPage(verifyUrl: String): String =
        """<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title></head><body><p>Confirming your payment...</p>
<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{var h=location.hash||"",q=new URLSearchParams(location.search);var t=q.get("token")||new URLSearchParams(h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");var u=new URL(${scriptJson(verifyUrl)},location.href);if(t)u.searchParams.set("token",t);location.replace(u.toString())}</script></body></html>"""
}
