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
            return Payments(built)
        }
    }
}

/**
 * Build config from environment variables (same names as the TS/Python ports; references/env.md).
 * A provider is enabled when its required vars are non-empty. CONNECTIPS_PRIVATE_KEY_PEM ("\n" escapes allowed)
 * is parsed here, so a bad key fails at boot.
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

    return PaymentsConfig(esewa, khalti, fonepay, connectips, cybersource, nps, imepay)
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
