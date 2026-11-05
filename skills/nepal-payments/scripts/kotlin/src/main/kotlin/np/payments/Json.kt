/*
 * Small strict JSON (RFC 8259) reader/writer so the adapters need nothing beyond the JDK.
 *
 * parse():  object -> Map<String, Any?> (LinkedHashMap, insertion order, duplicate keys: last wins)
 *           array -> List<Any?>, string -> String, number -> BigDecimal (exact digits: 110.0 keeps scale 1),
 *           true/false -> Boolean, null -> null. Trailing garbage, comments, trailing commas, leading zeros,
 *           NaN/Infinity, raw control characters and nesting deeper than [MAX_DEPTH] are rejected.
 * stringify(): JSON.stringify-compatible output (no whitespace, same escapes) for Map/Iterable/Array/String/
 *           Number/Boolean/null. BigDecimal is written with toPlainString(), so it round-trips exactly.
 */
package np.payments

import java.math.BigDecimal
import java.math.BigInteger

class JsonException(message: String) : IllegalArgumentException(message)

object Json {
    const val MAX_DEPTH: Int = 512

    fun parse(text: String): Any? = Parser(text).parseDocument()

    fun stringify(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    /** A JSON string literal, quoted and escaped (JS `JSON.stringify(s)`). */
    fun quote(s: String): String = StringBuilder(s.length + 2).also { writeString(it, s) }.toString()

    private fun write(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> writeString(out, value)
            is Boolean -> out.append(value)
            is BigDecimal -> out.append(value.toPlainString())
            is BigInteger, is Long, is Int, is Short, is Byte -> out.append(value.toString())
            is Double -> if (value.isNaN() || value.isInfinite()) out.append("null") else out.append(jsString(value))
            is Float -> write(out, value.toDouble())
            is Char -> writeString(out, value.toString())
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) out.append(',')
                    first = false
                    writeString(out, k as? String ?: throw JsonException("JSON object keys must be strings, got ${k?.javaClass}"))
                    out.append(':')
                    write(out, v)
                }
                out.append('}')
            }
            is Iterable<*> -> writeArray(out, value.iterator())
            is Array<*> -> writeArray(out, value.iterator())
            else -> throw JsonException("not JSON-serializable: ${value.javaClass.name}")
        }
    }

    private fun writeArray(out: StringBuilder, items: Iterator<Any?>) {
        out.append('[')
        var first = true
        for (v in items) {
            if (!first) out.append(',')
            first = false
            write(out, v)
        }
        out.append(']')
    }

    private fun writeString(out: StringBuilder, s: String) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> appendUnicodeEscape(out, c)
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    out.append(c).append(s[i + 1])
                    i++
                }
                Character.isSurrogate(c) -> appendUnicodeEscape(out, c) // lone surrogate (well-formed JSON.stringify)
                else -> out.append(c)
            }
            i++
        }
        out.append('"')
    }

    private fun appendUnicodeEscape(out: StringBuilder, c: Char) {
        out.append("\\u").append(Integer.toHexString(c.code).padStart(4, '0'))
    }

    private class Parser(private val s: String) {
        private var i = 0
        private var depth = 0

        fun parseDocument(): Any? {
            skipWhitespace()
            val v = parseValue()
            skipWhitespace()
            if (i != s.length) fail("unexpected data after JSON value")
            return v
        }

        private fun fail(message: String): Nothing = throw JsonException("$message at offset $i")

        private fun skipWhitespace() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        private fun parseValue(): Any? {
            if (i >= s.length) fail("unexpected end of input")
            return when (val c = s[i]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') parseNumber() else fail("unexpected character '$c'")
            }
        }

        private fun literal(word: String, value: Any?): Any? {
            if (!s.startsWith(word, i)) fail("invalid literal")
            i += word.length
            return value
        }

        private fun enter() {
            if (++depth > MAX_DEPTH) fail("nesting deeper than $MAX_DEPTH")
        }

        private fun parseObject(): Map<String, Any?> {
            enter()
            i++ // {
            val out = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (i < s.length && s[i] == '}') {
                i++
                depth--
                return out
            }
            while (true) {
                skipWhitespace()
                if (i >= s.length || s[i] != '"') fail("expected string key")
                val key = parseString()
                skipWhitespace()
                if (i >= s.length || s[i] != ':') fail("expected ':'")
                i++
                skipWhitespace()
                out[key] = parseValue()
                skipWhitespace()
                if (i >= s.length) fail("unterminated object")
                when (s[i]) {
                    ',' -> i++
                    '}' -> {
                        i++
                        depth--
                        return out
                    }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun parseArray(): List<Any?> {
            enter()
            i++ // [
            val out = ArrayList<Any?>()
            skipWhitespace()
            if (i < s.length && s[i] == ']') {
                i++
                depth--
                return out
            }
            while (true) {
                skipWhitespace()
                out.add(parseValue())
                skipWhitespace()
                if (i >= s.length) fail("unterminated array")
                when (s[i]) {
                    ',' -> i++
                    ']' -> {
                        i++
                        depth--
                        return out
                    }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun parseString(): String {
            i++ // opening quote
            val out = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail("unterminated escape")
                        when (val e = s[i++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            // UTF-16 code unit; a 😀 pair becomes one supplementary character.
                            'u' -> out.append(parseHex4())
                            else -> {
                                i--
                                fail("invalid escape '\\$e'")
                            }
                        }
                    }
                    c < ' ' -> {
                        i--
                        fail("unescaped control character in string")
                    }
                    else -> out.append(c)
                }
            }
        }

        private fun parseHex4(): Char {
            if (i + 4 > s.length) fail("truncated \\u escape")
            var v = 0
            repeat(4) {
                val d = Character.digit(s[i], 16)
                if (d < 0 || s[i].code > 0x7f) fail("invalid \\u escape")
                v = v * 16 + d
                i++
            }
            return v.toChar()
        }

        private fun parseNumber(): BigDecimal {
            val start = i
            if (s[i] == '-') i++
            if (i >= s.length) fail("truncated number")
            if (s[i] == '0') {
                i++
                if (i < s.length && s[i] in '0'..'9') fail("leading zero in number")
            } else if (s[i] in '1'..'9') {
                while (i < s.length && s[i] in '0'..'9') i++
            } else {
                fail("invalid number")
            }
            if (i < s.length && s[i] == '.') {
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail("digit expected after '.'")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail("digit expected in exponent")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return try {
                BigDecimal(s.substring(start, i))
            } catch (e: NumberFormatException) {
                i = start
                fail("number out of range")
            }
        }
    }
}
