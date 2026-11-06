/*
 * Shared types for every provider adapter. Port of scripts/ts/src/core.ts.
 *
 * SERVER-SIDE ONLY. These classes hold merchant secrets; never ship them inside an Android/iOS app.
 * Runtime: JDK 17+ and kotlin-stdlib. No other dependencies.
 */
package np.payments

import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

enum class ProviderId(val wire: String) {
    ESEWA("esewa"),
    KHALTI("khalti"),
    FONEPAY("fonepay"),
    CONNECTIPS("connectips"),
    CYBERSOURCE("cybersource"),
    NPS("nps"),
    IMEPAY("imepay"),
    NEPALPAY("nepalpay");

    companion object {
        fun fromWire(value: String): ProviderId? = entries.firstOrNull { it.wire == value }
    }
}

/** Provider environment. `*_ENV=production` or `live` selects [PRODUCTION]; anything else is [SANDBOX]. */
enum class Environment { SANDBOX, PRODUCTION }

/** Status as stored on a payment attempt row: a [PaymentStatus], or [Initiated] (created, provider not heard from yet). */
sealed interface AttemptStatus {
    /** The string stored in the database (same values as the TS/Python ports). */
    val wire: String

    data object Initiated : AttemptStatus {
        override val wire: String get() = "initiated"
    }

    companion object {
        fun fromWire(value: String): AttemptStatus? =
            if (value == Initiated.wire) Initiated else PaymentStatus.fromWire(value)
    }
}

/** Normalized payment state. Every provider status maps onto exactly one of these. */
enum class PaymentStatus(override val wire: String) : AttemptStatus {
    /** Money captured; safe to fulfil. */
    PAID("paid"),
    /** Provider has not settled yet; re-check later, do NOT fulfil. */
    PENDING("pending"),
    /** Declined / error; let the user retry with a NEW order id. */
    FAILED("failed"),
    /** User backed out. */
    CANCELED("canceled"),
    /** Session timed out before payment. */
    EXPIRED("expired"),
    REFUNDED("refunded"),
    PARTIALLY_REFUNDED("partially_refunded"),
    /** Provider has no record (never started, or wrong env/credentials). */
    NOT_FOUND("not_found"),
    /** Anything unmapped; treat like pending and alert. */
    UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String): PaymentStatus? = entries.firstOrNull { it.wire == value }
    }
}

data class VerifyResult(
    val provider: ProviderId,
    val status: PaymentStatus,
    /** Your order / transaction id as known to the provider. */
    val orderId: String,
    /** Amount the PROVIDER says was paid, in paisa (1 NPR = 100 paisa). null if the provider doesn't say. */
    val amountPaisa: Long?,
    /** Provider's final transaction id (eSewa ref_id, Khalti transaction_id, ...). Store it; support and refunds need it. */
    val transactionId: String?,
    /** Untouched provider response (parsed JSON: Map/List/String/BigDecimal/Boolean/null), for audit logs. */
    val raw: Any?,
)

sealed interface InitiateResult {
    /** Persist when non-null (Khalti pidx, NPS ProcessId, IME Pay TokenId): verify() needs it. */
    val providerRef: String?

    /** Redirect the browser (or open a WebView / Custom Tab) to [url]. */
    data class Redirect(
        val url: String,
        override val providerRef: String? = null,
        val expiresAt: String? = null,
        val raw: Any? = null,
    ) : InitiateResult

    /** Render an auto-submitting HTML form that POSTs [fields] to [action] (see [renderAutoSubmitForm]). */
    data class Form(
        val action: String,
        val fields: Map<String, String>,
        val method: String = "POST",
        /** null = application/x-www-form-urlencoded. NPS requires [MULTIPART]. */
        val enctype: String? = null,
        override val providerRef: String? = null,
    ) : InitiateResult

    /**
     * Show a QR the payer scans from their own app (NEPALPAY QR). Render [qrString] with any QR library, or
     * `<img src="data:image/png;base64,$qrImage">` when the provider sent an image. Persist [providerRef].
     */
    data class Qr(
        val qrString: String,
        /** Base64 PNG, when the provider sent one. */
        val qrImage: String? = null,
        override val providerRef: String,
        val raw: Any? = null,
    ) : InitiateResult

    companion object {
        const val MULTIPART: String = "multipart/form-data"
    }
}

data class Customer(val name: String? = null, val email: String? = null, val phone: String? = null)

data class InitiateInput(
    /** Unique per payment ATTEMPT (not per order). Provider-safe charset: [A-Za-z0-9-]. See [newOrderId]. */
    val orderId: String,
    /** Integer paisa, computed server-side from your order. */
    val amountPaisa: Long,
    /** Shown to the payer where the provider supports it. */
    val description: String,
    /** Where the provider sends the payer back (your server route). */
    val returnUrl: String,
    /** Some providers have a separate failure URL; defaults to [returnUrl]. */
    val failureUrl: String? = null,
    val customer: Customer? = null,
)

data class VerifyInput(
    val orderId: String,
    /** The amount YOU stored for this attempt. */
    val amountPaisa: Long,
    /** The providerRef returned by initiate() (Khalti pidx, NPS ProcessId, IME Pay TokenId...), from YOUR db. */
    val providerRef: String? = null,
    /** Raw query/body params the provider sent to your return URL, if any. */
    val callback: Map<String, String>? = null,
)

interface PaymentAdapter {
    val id: ProviderId

    suspend fun initiate(input: InitiateInput): InitiateResult

    /** Server-to-server confirmation. Never trust callback params alone. */
    suspend fun verify(input: VerifyInput): VerifyResult

    /** Extract YOUR order id from return-URL params so you can load the attempt. */
    fun orderIdFromCallback(params: Map<String, String>): String?
}

class PaymentException(
    message: String,
    val provider: ProviderId,
    val code: String,
    val httpStatus: Int? = null,
    val details: Any? = null,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

// ---------------------------------------------------------------------------
// State machine (references/architecture.md §2, §4).
// ---------------------------------------------------------------------------

val OPEN_STATUSES: Set<AttemptStatus> = setOf(AttemptStatus.Initiated, PaymentStatus.PENDING, PaymentStatus.UNKNOWN)

/** Statuses after which a provider notification may be acknowledged (references/nps.md, Notification URL). */
val FINAL_STATUSES: Set<AttemptStatus> = setOf(
    PaymentStatus.PAID, PaymentStatus.FAILED, PaymentStatus.CANCELED,
    PaymentStatus.EXPIRED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED,
)

private val CLOSED_UNPAID: Set<AttemptStatus> =
    setOf(PaymentStatus.FAILED, PaymentStatus.CANCELED, PaymentStatus.EXPIRED, PaymentStatus.NOT_FOUND)

data class TransitionDecision(
    /** Status to write, or null to write nothing. */
    val next: PaymentStatus?,
    /** Stop automation and alert a human (amount mismatch / provider gave no amount for a "paid"). */
    val reviewRequired: Boolean,
    /** Provider says paid after we had closed the attempt: recover + alert. */
    val latePaid: Boolean,
    val reason: String,
)

/**
 * Pure state-machine decision for a verify() result.
 * Apply [TransitionDecision.next] with a conditional UPDATE guarded by [prev], and fulfil only if next == PAID.
 * Refund transitions (paid -> refunded) come from your refund flow, not from here.
 */
fun decideTransition(
    prev: AttemptStatus,
    status: PaymentStatus,
    amountPaisa: Long?,
    storedAmountPaisa: Long,
    attemptAge: Duration,
    sessionWindow: Duration = 60.minutes,
): TransitionDecision {
    val latePaid = status == PaymentStatus.PAID && prev in CLOSED_UNPAID
    if (prev !in OPEN_STATUSES && !latePaid) {
        return TransitionDecision(null, reviewRequired = false, latePaid = false, reason = "attempt already ${prev.wire}")
    }
    if (status == PaymentStatus.PAID && amountPaisa != storedAmountPaisa) {
        return TransitionDecision(
            PaymentStatus.UNKNOWN,
            reviewRequired = true,
            latePaid = latePaid,
            reason = if (amountPaisa == null) "provider returned no amount for a paid status"
            else "amount mismatch: stored $storedAmountPaisa, provider $amountPaisa",
        )
    }
    var next = status
    if (next == PaymentStatus.NOT_FOUND) {
        // Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
        if (attemptAge < sessionWindow) {
            return TransitionDecision(null, reviewRequired = false, latePaid = false, reason = "not_found inside session window")
        }
        next = PaymentStatus.EXPIRED
    }
    if (next == prev) return TransitionDecision(null, reviewRequired = false, latePaid = false, reason = "unchanged")
    return TransitionDecision(
        next,
        reviewRequired = false,
        latePaid = latePaid,
        reason = if (latePaid) "late payment (was ${prev.wire})" else "${prev.wire} -> ${next.wire}",
    )
}

/** Same as the other overload, taking status + amount from a [VerifyResult]. */
fun decideTransition(
    prev: AttemptStatus,
    result: VerifyResult,
    storedAmountPaisa: Long,
    attemptAge: Duration,
    sessionWindow: Duration = 60.minutes,
): TransitionDecision = decideTransition(prev, result.status, result.amountPaisa, storedAmountPaisa, attemptAge, sessionWindow)
