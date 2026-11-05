package np.payments;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class JsonTest {

    @Test
    @DisplayName("parse: types, document order, exact number text")
    void parseTypes() {
        Object v = Json.parse(" {\"b\":1,\"a\":[true,false,null,\"s\"],\"n\":110.0,\"m\":110,\"e\":-1.5e3,\"o\":{}} ");
        Map<?, ?> m = assertInstanceOf(LinkedHashMap.class, v);
        assertEquals(List.of("b", "a", "n", "m", "e", "o"), List.copyOf(m.keySet()));
        assertEquals(Arrays.asList(true, false, null, "s"), m.get("a"));
        assertEquals("110.0", ((BigDecimal) m.get("n")).toString()); // eSewa: 110.0 vs 110 must stay distinguishable
        assertEquals("110", ((BigDecimal) m.get("m")).toString());
        assertEquals(0, new BigDecimal("-1500").compareTo((BigDecimal) m.get("e")));
        assertEquals(Map.of(), m.get("o"));
        assertNull(Json.parse("null"));
        assertEquals("x", Json.parse("\"x\""));
    }

    @Test
    @DisplayName("parse: escapes incl. \\uXXXX and surrogate pairs; duplicate key keeps last value")
    void parseEscapes() {
        assertEquals("\"\\/\b\f\n\r\t", Json.parse("\"\\\"\\\\\\/\\b\\f\\n\\r\\t\""));
        assertEquals("é😀", Json.parse("\"\\u00E9\\ud83d\\ude00\""));
        assertEquals(0x1F600, ((String) Json.parse("\"\\ud83d\\ude00\"")).codePointAt(0));
        assertEquals("\uD800", Json.parse("\"\\uD800\"")); // lone surrogate accepted, like JSON.parse
        assertEquals("ü 😀", Json.parse("\"ü 😀\""));
        assertEquals(Map.of("a", new BigDecimal("2")), Json.parse("{\"a\":1,\"a\":2}"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "{", "[1,]", "{\"a\":1,}", "{\"a\" 1}", "{'a':1}", "01", "-", "1.", ".5", "+1", "1e", "0x10", "NaN",
            "Infinity", "tru", "nul", "\"abc", "\"a\nb\"", "\"\\x\"", "\"\\u12\"", "\"\\u12G4\"", "{} x", "[1] [2]", "1 2", "\uFEFF{}", "{a:1}", "[1,2", "// c\n1"})
    @DisplayName("parse rejects malformed JSON and trailing data")
    void rejects(String bad) {
        assertThrows(JsonException.class, () -> Json.parse(bad));
    }

    @Test
    @DisplayName("parse: nesting limit")
    void depth() {
        assertThrows(JsonException.class, () -> Json.parse("[".repeat(600) + "]".repeat(600)));
        assertEquals(1, ((List<?>) Json.parse("[".repeat(100) + "]".repeat(100))).size());
    }

    @Test
    @DisplayName("write: JSON.stringify format and escaping")
    void write() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("s", "a\"b\\c/\n\u0001é😀\uD800");
        m.put("l", 1000L);
        m.put("d", new BigDecimal("100.5"));
        m.put("f", 1.0);
        m.put("b", true);
        m.put("n", null);
        m.put("a", List.of(1, "x"));
        assertEquals("{\"s\":\"a\\\"b\\\\c/\\n\\u0001é😀\\ud800\",\"l\":1000,\"d\":100.5,\"f\":1,\"b\":true,\"n\":null,\"a\":[1,\"x\"]}", Json.write(m));
        assertEquals(m.get("s"), Json.parse(Json.write(m.get("s"))));
        assertEquals("\"x\"", Json.quote("x"));
        assertThrows(IllegalArgumentException.class, () -> Json.write(Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> Json.write(new Object()));
        assertTrue(Json.write(Map.of("k", Map.of())).equals("{\"k\":{}}"));
    }
}
