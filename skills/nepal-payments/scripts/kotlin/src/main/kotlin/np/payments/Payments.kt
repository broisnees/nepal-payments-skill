/*
 * nepal-payments: one interface over Nepali payment providers. Port of scripts/ts/src/index.ts.
 *
 *   val payments = Payments.create(paymentsConfigFromEnv())
 *   val r = payments.khalti.initiate(InitiateInput(orderId, amountPaisa, description, returnUrl))
 *   val v = payments.khalti.verify(VerifyInput(orderId, amountPaisa, providerRef = storedPidx))
 */
package np.payments

import java.security.SecureRandom

data class PaymentsConfig(
    val esewa: EsewaConfig? = null,
    val khalti: KhaltiConfig? = null,
    val fonepay: FonepayConfig? = null,
    val connectips: ConnectIpsConfig? = null,
    val cybersource: CyberSourceConfig? = null,
    val nps: NpsConfig? = null,
    val imepay: ImePayConfig? = null,
    val nepalpay: NepalPayConfig? = null,
    val hamropay: HamroPayConfig? = null,
    val getpay: GetPayConfig? = null,
)

class Payments private constructor(private val built: Map<ProviderId, PaymentAdapter>) {
    /** Configured providers. */
    val enabled: List<ProviderId> = built.keys.toList()

    /** Typed access to a configured provider (throws IllegalStateException if not configured). */
    val esewa: Esewa get() = typed(ProviderId.ESEWA)
    val khalti: Khalti get() = typed(ProviderId.KHALTI)
    val fonepay: Fonepay get() = typed(ProviderId.FONEPAY)
    val connectips: ConnectIps get() = typed(ProviderId.CONNECTIPS)
    val cybersource: CyberSource get() = typed(ProviderId.CYBERSOURCE)
    val nps: Nps get() = typed(ProviderId.NPS)
    val imepay: ImePay get() = typed(ProviderId.IMEPAY)
    val nepalpay: NepalPay get() = typed(ProviderId.NEPALPAY)
    val hamropay: HamroPay get() = typed(ProviderId.HAMROPAY)
    val getpay: GetPay get() = typed(ProviderId.GETPAY)

    fun adapter(id: ProviderId): PaymentAdapter =
        built[id] ?: throw IllegalStateException("payment provider \"${id.wire}\" is not configured")

    /** Untyped access for generic handlers keyed by a route param ("esewa", "khalti", ...). */
    fun adapter(id: String): PaymentAdapter =
        ProviderId.fromWire(id)?.let { built[it] } ?: throw IllegalStateException("payment provider \"$id\" is not configured")

    private inline fun <reified T : PaymentAdapter> typed(id: ProviderId): T = adapter(id) as T

    companion object {
        /** [transport] is shared by every HTTP-based adapter (default: [JdkHttpTransport]). */
        fun create(config: PaymentsConfig, transport: HttpTransport = HttpTransport.Default): Payments {
            val built = LinkedHashMap<ProviderId, PaymentAdapter>()
            config.esewa?.let { built[ProviderId.ESEWA] = Esewa(it, transport) }
            config.khalti?.let { built[ProviderId.KHALTI] = Khalti(it, transport) }
            config.fonepay?.let { built[ProviderId.FONEPAY] = Fonepay(it, transport) }
            config.connectips?.let { built[ProviderId.CONNECTIPS] = ConnectIps(it, transport) }
            config.cybersource?.let { built[ProviderId.CYBERSOURCE] = CyberSource(it) }
            config.nps?.let { built[ProviderId.NPS] = Nps(it, transport) }
            config.imepay?.let { built[ProviderId.IMEPAY] = ImePay(it, transport) }
            config.nepalpay?.let { built[ProviderId.NEPALPAY] = NepalPay(it, transport) }
            config.hamropay?.let { built[ProviderId.HAMROPAY] = HamroPay(it, transport) }
            config.getpay?.let { built[ProviderId.GETPAY] = GetPay(it, transport) }
            return Payments(built)
        }
    }
}

/**
 * Build config from environment variables (same names as the TS/Python ports; references/env.md).
 * A provider is enabled when its required vars are non-empty. CONNECTIPS_PRIVATE_KEY_PEM, NEPALPAY_PRIVATE_KEY_PEM
 * and NEPALPAY_NCHL_PUBLIC_KEY_PEM ("\n" escapes allowed) are parsed here, so a bad key fails at boot.
 */
fun paymentsConfigFromEnv(env: Map<String, String?> = System.getenv()): PaymentsConfig {
    fun v(name: String): String? = env[name].orNullIfEmpty()
    fun mode(name: String) = if (env[name] == "production" || env[name] == "live") Environment.PRODUCTION else Environment.SANDBOX

    val esewa = if (v("ESEWA_PRODUCT_CODE") != null && v("ESEWA_SECRET_KEY") != null) {
        val intentCode = v("ESEWA_INTENT_PRODUCT_CODE")
        val intentKey = v("ESEWA_INTENT_ACCESS_KEY")
        EsewaConfig(
            env = mode("ESEWA_ENV"),
            productCode = v("ESEWA_PRODUCT_CODE")!!,
            secretKey = v("ESEWA_SECRET_KEY")!!,
            intent = if (intentCode != null && intentKey != null) EsewaIntentCredentials(intentCode, intentKey, env["ESEWA_INTENT_BASE_URL"]) else null,
        )
    } else null

    val khalti = if (v("KHALTI_SECRET_KEY") != null && v("KHALTI_WEBSITE_URL") != null) {
        KhaltiConfig(secretKey = v("KHALTI_SECRET_KEY")!!, env = mode("KHALTI_ENV"), websiteUrl = v("KHALTI_WEBSITE_URL")!!)
    } else null

    val fonepay = if (v("FONEPAY_MERCHANT_CODE") != null && v("FONEPAY_SECRET_KEY") != null) {
        FonepayConfig(
            env = mode("FONEPAY_ENV"),
            merchantCode = v("FONEPAY_MERCHANT_CODE")!!,
            secretKey = v("FONEPAY_SECRET_KEY")!!,
            username = env["FONEPAY_USERNAME"],
            password = env["FONEPAY_PASSWORD"],
        )
    } else null

    val connectips = if (v("CONNECTIPS_MERCHANT_ID") != null && v("CONNECTIPS_APP_ID") != null && v("CONNECTIPS_PRIVATE_KEY_PEM") != null) {
        ConnectIpsConfig(
            env = mode("CONNECTIPS_ENV"),
            merchantId = v("CONNECTIPS_MERCHANT_ID")!!,
            appId = v("CONNECTIPS_APP_ID")!!,
            appName = env["CONNECTIPS_APP_NAME"] ?: "",
            appPassword = env["CONNECTIPS_APP_PASSWORD"] ?: "",
            privateKey = loadPkcs8PrivateKey(v("CONNECTIPS_PRIVATE_KEY_PEM")!!.replace("\\n", "\n")),
        )
    } else null

    val cybersource = if (v("CYBERSOURCE_PROFILE_ID") != null && v("CYBERSOURCE_ACCESS_KEY") != null && v("CYBERSOURCE_SECRET_KEY") != null) {
        CyberSourceConfig(
            env = mode("CYBERSOURCE_ENV"),
            profileId = v("CYBERSOURCE_PROFILE_ID")!!,
            accessKey = v("CYBERSOURCE_ACCESS_KEY")!!,
            secretKey = v("CYBERSOURCE_SECRET_KEY")!!,
            currency = env["CYBERSOURCE_CURRENCY"] ?: "NPR",
        )
    } else null

    val nps = if (v("NPS_MERCHANT_ID") != null && v("NPS_SECRET_KEY") != null) {
        NpsConfig(
            env = mode("NPS_ENV"),
            merchantId = v("NPS_MERCHANT_ID")!!,
            merchantName = env["NPS_MERCHANT_NAME"] ?: "",
            apiUsername = env["NPS_API_USERNAME"] ?: "",
            apiPassword = env["NPS_API_PASSWORD"] ?: "",
            secretKey = v("NPS_SECRET_KEY")!!,
        )
    } else null

    val imepay = if (v("IMEPAY_MERCHANT_CODE") != null && v("IMEPAY_USERNAME") != null) {
        ImePayConfig(
            env = mode("IMEPAY_ENV"),
            merchantCode = v("IMEPAY_MERCHANT_CODE")!!,
            username = v("IMEPAY_USERNAME")!!,
            password = env["IMEPAY_PASSWORD"] ?: "",
            module = env["IMEPAY_MODULE"] ?: "",
        )
    } else null

    val nepalpay = if (v("NEPALPAY_ACQUIRER_ID") != null && v("NEPALPAY_MERCHANT_ID") != null && v("NEPALPAY_USERNAME") != null &&
        v("NEPALPAY_PRIVATE_KEY_PEM") != null
    ) {
        val clientId = v("NEPALPAY_CLIENT_ID")
        val wsUrl = v("NEPALPAY_WS_URL")
        NepalPayConfig(
            env = mode("NEPALPAY_ENV"),
            acquirerId = v("NEPALPAY_ACQUIRER_ID")!!,
            merchantId = v("NEPALPAY_MERCHANT_ID")!!,
            merchantName = env["NEPALPAY_MERCHANT_NAME"] ?: "",
            merchantCategoryCode = env["NEPALPAY_MCC"] ?: "",
            merchantCity = env["NEPALPAY_MERCHANT_CITY"] ?: "Kathmandu",
            merchantPostalCode = env["NEPALPAY_MERCHANT_POSTAL_CODE"] ?: "44600",
            storeLabel = env["NEPALPAY_STORE_LABEL"] ?: "Store1",
            terminalLabel = env["NEPALPAY_TERMINAL_LABEL"],
            username = v("NEPALPAY_USERNAME")!!,
            password = env["NEPALPAY_PASSWORD"] ?: "",
            privateKey = loadPkcs8PrivateKey(v("NEPALPAY_PRIVATE_KEY_PEM")!!.replace("\\n", "\n")),
            auth = if (clientId != null) NepalPayAuth.OAUTH else NepalPayAuth.BASIC,
            clientId = clientId,
            clientSecret = if (clientId != null) env["NEPALPAY_CLIENT_SECRET"] ?: "" else null,
            nchlPublicKey = v("NEPALPAY_NCHL_PUBLIC_KEY_PEM")?.let { loadSpkiPublicKey(it.replace("\\n", "\n")) },
            wsUrl = wsUrl,
            wsUsername = if (wsUrl != null) env["NEPALPAY_WS_USERNAME"] else null,
            wsApiToken = if (wsUrl != null) env["NEPALPAY_WS_API_TOKEN"] else null,
        )
    } else null

    val hamropay = if (v("HAMROPAY_MERCHANT_ID") != null && v("HAMROPAY_CLIENT_ID") != null && v("HAMROPAY_CLIENT_API_KEY") != null &&
        v("HAMROPAY_CLIENT_SECRET") != null
    ) {
        HamroPayConfig(
            env = mode("HAMROPAY_ENV"),
            merchantId = v("HAMROPAY_MERCHANT_ID")!!,
            clientId = v("HAMROPAY_CLIENT_ID")!!,
            clientApiKey = v("HAMROPAY_CLIENT_API_KEY")!!,
            clientSecret = v("HAMROPAY_CLIENT_SECRET")!!,
            webhookSecret = env["HAMROPAY_WEBHOOK_SECRET"],
            apiBaseUrl = env["HAMROPAY_API_BASE_URL"],
            gatewayUrl = env["HAMROPAY_GATEWAY_URL"],
        )
    } else null

    val getpay = if (v("GETPAY_PAP_INFO") != null && v("GETPAY_OPR_KEY") != null && v("GETPAY_WEBSITE_DOMAIN") != null) {
        GetPayConfig(
            env = mode("GETPAY_ENV"),
            papInfo = v("GETPAY_PAP_INFO")!!,
            oprKey = v("GETPAY_OPR_KEY")!!,
            insKey = env["GETPAY_INS_KEY"],
            websiteDomain = v("GETPAY_WEBSITE_DOMAIN")!!,
            businessName = env["GETPAY_BUSINESS_NAME"] ?: "",
            imageUrl = env["GETPAY_IMAGE_URL"] ?: "",
            currency = env["GETPAY_CURRENCY"] ?: "NPR",
            bundleUrl = env["GETPAY_BUNDLE_URL"],
            baseUrl = env["GETPAY_BASE_URL"],
        )
    } else null

    return PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, imepay, nepalpay, hamropay, getpay)
}

private val RANDOM = SecureRandom()
private const val ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * Short, provider-safe attempt id: <= 20 chars, [A-Z0-9] (fits connectIPS TXNID 20, Fonepay PRN 25, eSewa uuid
 * charset, Khalti/NPS/IME/CyberSource limits). Example: "P1KX3M9Q2ZAB7C4D8E".
 */
fun newOrderId(prefix: String = "P"): String {
    val time = java.lang.Long.toString(System.currentTimeMillis(), 36).uppercase() // 8–9 chars
    val tail = String(CharArray(10) { ALPHABET[RANDOM.nextInt(ALPHABET.length)] })
    return (prefix + time + tail).take(20)
}
