/*
 * Money. Keep money as integer paisa (Long) everywhere; convert only at the provider edge. Never use floats.
 */
package np.payments

import java.math.BigDecimal
import java.math.RoundingMode

/** Largest integer every port (TS/JS included) can represent exactly: 2^53 - 1. */
const val MAX_SAFE_PAISA: Long = 9_007_199_254_740_991L

fun assertPaisa(paisa: Long, provider: ProviderId) {
    if (paisa <= 0 || paisa > MAX_SAFE_PAISA) {
        throw PaymentException("amount must be a positive integer in paisa, got $paisa", provider, "invalid_amount")
    }
}

/** 12345 -> "123.45", 10000 -> "100", 5 -> "0.05". */
fun paisaToRupees(paisa: Long): String {
    val rupees = paisa / 100
    val rem = Math.abs(paisa % 100)
    val whole = if (paisa < 0 && rupees == 0L) "-0" else rupees.toString()
    return if (rem == 0L) whole else whole + "." + rem.toString().padStart(2, '0')
}

private val RUPEE_PATTERN = Regex("^-?\\d+(\\.\\d+)?$")

/**
 * "123.45" | "1,000.0" | "100" -> paisa. Rounds half away from zero on the 3rd decimal.
 * Accepts plain decimal strings only (no exponent, no leading '+' or '.'), like the TS port.
 */
fun rupeesToPaisa(rupees: String): Long {
    val s = rupees.trim().replace(",", "")
    if (!RUPEE_PATTERN.matches(s)) throw IllegalArgumentException("not a rupee amount: $rupees")
    return decimalToPaisa(BigDecimal(s), rupees)
}

/**
 * Numeric overload (JSON numbers arrive as BigDecimal). Doubles go through their shortest decimal text,
 * so 1.005 -> 101 (not the binary 1.00499...). Values a JS port would print in exponent form are rejected.
 */
fun rupeesToPaisa(rupees: Number): Long {
    val value: BigDecimal = when (rupees) {
        is BigDecimal -> rupees
        is Long, is Int, is Short, is Byte -> BigDecimal.valueOf(rupees.toLong())
        is java.math.BigInteger -> BigDecimal(rupees)
        else -> {
            val d = rupees.toDouble()
            if (d.isNaN() || d.isInfinite()) throw IllegalArgumentException("not a rupee amount: $rupees")
            BigDecimal(d.toString())
        }
    }
    val abs = value.abs()
    if (abs >= JS_EXPONENT_HIGH || (abs.signum() != 0 && abs < JS_EXPONENT_LOW)) {
        throw IllegalArgumentException("not a rupee amount: $rupees")
    }
    return decimalToPaisa(value, rupees)
}

/** Provider JSON value (String or number) -> paisa; anything else is rejected. */
internal fun rupeesToPaisaValue(value: Any?): Long = when (value) {
    is String -> rupeesToPaisa(value)
    is Number -> rupeesToPaisa(value)
    else -> throw IllegalArgumentException("not a rupee amount: ${jsString(value)}")
}

private fun decimalToPaisa(value: BigDecimal, original: Any): Long = try {
    value.setScale(2, RoundingMode.HALF_UP).unscaledValue().longValueExact()
} catch (e: ArithmeticException) {
    throw IllegalArgumentException("not a rupee amount: $original", e)
}

/** Rupees with exactly two decimals ("100.00"), for providers that want that format. */
internal fun paisaToRupees2dp(paisa: Long): String {
    val rem = Math.abs(paisa % 100)
    val whole = if (paisa < 0 && paisa / 100 == 0L) "-0" else (paisa / 100).toString()
    return whole + "." + rem.toString().padStart(2, '0')
}
