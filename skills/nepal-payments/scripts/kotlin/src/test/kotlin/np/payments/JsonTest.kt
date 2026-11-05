package np.payments

import org.junit.jupiter.api.DisplayName
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class JsonTest {
    @Test
    @DisplayName("[kt] json: parses every value type into Map/List/String/BigDecimal/Boolean/null")
    fun types() {
        val v = Json.parse(""" { "a" : [1, -2.5e3, true, false, null, "s"], "b": {} , "c": [] } """).asJsonObject()!!
        assertEquals(listOf(BigDecimal("1"), BigDecimal("-2.5e3"), true, false, null, "s"), v["a"])
        assertEquals(emptyMap<String, Any?>(), v["b"])
        assertEquals(emptyList<Any?>(), v["c"])
        assertEquals(listOf("a", "b", "c"), v.keys.toList())
        assertNull(Json.parse("null"))
        assertEquals("x", Json.parse("\"x\""))
    }

    @Test
    @DisplayName("[kt] json: numbers keep their exact text (110.0 vs 110)")
    fun exactNumbers() {
        assertEquals("110.0", (Json.parse("110.0") as BigDecimal).toPlainString())
        assertEquals("110", (Json.parse("110") as BigDecimal).toPlainString())
        assertEquals("12345678901234567890", (Json.parse("12345678901234567890") as BigDecimal).toPlainString())
        assertEquals("{\"total_amount\":110.0}", Json.stringify(Json.parse("{\"total_amount\":110.0}")))
    }

    @Test
    @DisplayName("[kt] json: escapes incl. \\uXXXX surrogate pairs")
    fun escapes() {
        assertEquals("q\"b\\s/\b\u000C\n\r\t\u00e9", Json.parse("\"q\\\"b\\\\s\\/\\b\\f\\n\\r\\t\\u00E9\""))
        assertEquals("😀", Json.parse("\"\\uD83D\\uDE00\""))
        assertEquals("😀", Json.parse("\"😀\""))
        assertEquals("\uD800", Json.parse("\"\\ud800\"")) // lone surrogate accepted, like JSON.parse
    }

    @Test
    @DisplayName("[kt] json: rejects trailing garbage and non-JSON syntax")
    fun strict() {
        for (bad in listOf(
            "", " ", "{} x", "[1,]", "{\"a\":1,}", "01", "-", "1.", ".5", "+1", "1e", "NaN", "Infinity", "'a'", "{a:1}",
            "\"a\u0001\"", "\"\\x\"", "\"\\u12G4\"", "\"abc", "[1 2]", "tru", "nul", "// c\n1", "{\"a\" 1}", "\uFEFF{}",
        )) {
            assertFailsWith<JsonException>(bad) { Json.parse(bad) }
        }
        assertFailsWith<JsonException> { Json.parse("[".repeat(Json.MAX_DEPTH + 1) + "]".repeat(Json.MAX_DEPTH + 1)) }
        Json.parse("[".repeat(Json.MAX_DEPTH) + "]".repeat(Json.MAX_DEPTH))
    }

    @Test
    @DisplayName("[kt] json: duplicate keys keep the last value (JSON.parse semantics)")
    fun duplicates() {
        assertEquals(mapOf("a" to BigDecimal(2)), Json.parse("{\"a\":1,\"a\":2}"))
    }

    @Test
    @DisplayName("[kt] json: writer matches JSON.stringify output")
    fun writer() {
        val m = linkedMapOf<String, Any?>(
            "s" to "q\"\\\n\u0001é😀\uD800", "l" to 1000L, "i" to 3, "d" to 1.5, "bd" to BigDecimal("100.50"),
            "b" to true, "n" to null, "arr" to listOf(1, "x"), "o" to mapOf("k" to "v"),
        )
        assertEquals(
            "{\"s\":\"q\\\"\\\\\\n\\u0001é😀\\ud800\",\"l\":1000,\"i\":3,\"d\":1.5,\"bd\":100.50,\"b\":true,\"n\":null,\"arr\":[1,\"x\"],\"o\":{\"k\":\"v\"}}",
            Json.stringify(m),
        )
        val back = Json.parse(Json.stringify(m)).asJsonObject()!!
        assertEquals(m["s"], back["s"])
        assertEquals(BigDecimal("100.50"), back["bd"])
        assertEquals("\"d1549791827186\"", Json.quote("d1549791827186"))
        assertFailsWith<JsonException> { Json.stringify(mapOf(1 to 2)) }
        assertFailsWith<JsonException> { Json.stringify(Any()) }
    }
}
