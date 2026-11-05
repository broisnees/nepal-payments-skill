/*
 * Internal helpers that reproduce the JavaScript semantics the TS reference relies on
 * (String(x), truthiness, URLSearchParams, encodeURIComponent) for parsed JSON values.
 */
package np.payments

import java.math.BigDecimal
import java.net.URI
import java.net.URLEncoder

internal val JS_EXPONENT_HIGH = BigDecimal("1e21")
internal val JS_EXPONENT_LOW = BigDecimal("1e-6")

/** JS `String(value)` for JSON-shaped values. Numbers print like JS (no trailing zeros), but integers stay exact. */
internal fun jsString(value: Any?): String = when (value) {
    null -> "null"
    is String -> value
    is Boolean -> value.toString()
    is BigDecimal -> jsNumber(value)
    is Double -> if (value.isNaN()) "NaN" else if (value.isInfinite()) (if (value > 0) "Infinity" else "-Infinity") else jsNumber(BigDecimal(value.toString()))
    is Float -> jsString(value.toDouble())
    is Number -> value.toString()
    is Map<*, *> -> "[object Object]"
    is Iterable<*> -> value.joinToString(",") { if (it == null) "" else jsString(it) }
    else -> value.toString()
}

private fun jsNumber(n: BigDecimal): String {
    if (n.signum() == 0) return "0"
    val abs = n.abs()
    val stripped = n.stripTrailingZeros()
    if (abs < JS_EXPONENT_HIGH && abs >= JS_EXPONENT_LOW) return stripped.toPlainString()
    // JS switches to exponent form here; never expand (a crafted 1e999999999 must not allocate a huge string).
    val digits = stripped.unscaledValue().abs().toString()
    val exponent = digits.length.toLong() - 1 - stripped.scale()
    val mantissa = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
    return (if (n.signum() < 0) "-" else "") + mantissa + "e" + (if (exponent >= 0) "+" else "-") + Math.abs(exponent)
}

/** JS truthiness: null, "", false, 0 are falsy. */
internal fun jsTruthy(value: Any?): Boolean = when (value) {
    null -> false
    is Boolean -> value
    is String -> value.isNotEmpty()
    is BigDecimal -> value.signum() != 0
    is Double -> value != 0.0 && !value.isNaN()
    is Float -> value != 0f && !value.isNaN()
    is Number -> value.toLong() != 0L
    else -> true
}

/** Non-empty string or null (JS `x || null` for string params). */
internal fun String?.orNullIfEmpty(): String? = if (this.isNullOrEmpty()) null else this

/** Field of a parsed JSON object, or null when [this] is not an object (JS `obj?.field`). */
internal fun Any?.field(name: String): Any? = (this as? Map<*, *>)?.get(name)

@Suppress("UNCHECKED_CAST")
internal fun Any?.asJsonObject(): Map<String, Any?>? = if (this is Map<*, *>) this as Map<String, Any?> else null

/** application/x-www-form-urlencoded, byte-identical to WHATWG URLSearchParams#toString for valid strings. */
internal fun formEncode(params: Map<String, String>): String =
    params.entries.joinToString("&") { (k, v) -> urlEncode(k) + "=" + urlEncode(v) }

private fun urlEncode(s: String): String = URLEncoder.encode(s, Charsets.UTF_8)

/** JS encodeURIComponent. */
internal fun encodeURIComponent(s: String): String {
    val out = StringBuilder()
    for (b in s.toByteArray(Charsets.UTF_8)) {
        val c = b.toInt() and 0xff
        if (c < 0x80 && (c.toChar().isLetterOrDigit() || c.toChar() in "-_.!~*'()")) out.append(c.toChar())
        else out.append('%').append("0123456789ABCDEF"[c ushr 4]).append("0123456789ABCDEF"[c and 0x0f])
    }
    return out.toString()
}

/** JS `new URL(url).host` (host[:port]); falls back to the raw string when unparseable. */
internal fun hostOf(url: String): String = try {
    val u = URI(url)
    if (u.host == null) url else if (u.port == -1) u.host else "${u.host}:${u.port}"
} catch (e: Exception) {
    url
}
