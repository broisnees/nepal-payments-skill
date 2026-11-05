package np.payments;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small strict JSON (RFC 8259) reader/writer with JSON.parse / JSON.stringify semantics.
 * <ul>
 *   <li>parse: object -> LinkedHashMap (document order; duplicate key = last value), array -> ArrayList,
 *       string -> String, number -> BigDecimal built from the exact number text ("110.0" keeps its scale),
 *       true/false -> Boolean, null -> null. Rejects trailing data, leading zeros, trailing commas, comments,
 *       unescaped control characters and nesting deeper than 512.</li>
 *   <li>write: Map, Iterable, String, Number, Boolean, null. Strings escaped like JSON.stringify
 *       (lone surrogates as \\uXXXX). Non-finite numbers are rejected.</li>
 * </ul>
 */
public final class Json {
    static final int MAX_DEPTH = 512;

    private Json() {}

    public static Object parse(String text) {
        Parser p = new Parser(text);
        Object v = p.value(0);
        p.ws();
        if (p.i != text.length()) throw new JsonException("unexpected trailing data", p.i);
        return v;
    }

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, 0);
        return sb.toString();
    }

    /** JSON string literal for {@code s} (JSON.stringify(s)). */
    public static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        quote(sb, s);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v, int depth) {
        if (depth > MAX_DEPTH) throw new IllegalArgumentException("JSON nesting too deep (cycle?)");
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String s) {
            quote(sb, s);
        } else if (v instanceof Boolean || v instanceof Long || v instanceof Integer || v instanceof Short
                || v instanceof Byte || v instanceof BigInteger || v instanceof BigDecimal) {
            sb.append(v);
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (!Double.isFinite(d)) throw new IllegalArgumentException("JSON cannot represent " + d);
            sb.append(Js.numberToString(d));
        } else if (v instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (e.getKey() == null) throw new IllegalArgumentException("JSON object keys cannot be null");
                if (!first) sb.append(',');
                first = false;
                quote(sb, e.getKey().toString());
                sb.append(':');
                write(sb, e.getValue(), depth + 1);
            }
            sb.append('}');
        } else if (v instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object e : it) {
                if (!first) sb.append(',');
                first = false;
                write(sb, e, depth + 1);
            }
            sb.append(']');
        } else {
            throw new IllegalArgumentException("not JSON-serializable: " + v.getClass().getName());
        }
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    boolean lone = (Character.isHighSurrogate(c) && (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))))
                            || (Character.isLowSurrogate(c) && (i == 0 || !Character.isHighSurrogate(s.charAt(i - 1))));
                    if (c < 0x20 || lone) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
                i++;
            }
        }

        Object value(int depth) {
            ws();
            if (i >= s.length()) throw new JsonException("unexpected end of input", i);
            char c = s.charAt(i);
            switch (c) {
                case '{':
                    return object(depth + 1);
                case '[':
                    return array(depth + 1);
                case '"':
                    return string();
                case 't':
                    return literal("true", Boolean.TRUE);
                case 'f':
                    return literal("false", Boolean.FALSE);
                case 'n':
                    return literal("null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number();
                    throw new JsonException("unexpected character '" + c + "'", i);
            }
        }

        Object literal(String word, Object v) {
            if (!s.startsWith(word, i)) throw new JsonException("unexpected token", i);
            i += word.length();
            return v;
        }

        Map<String, Object> object(int depth) {
            if (depth > MAX_DEPTH) throw new JsonException("nesting deeper than " + MAX_DEPTH, i);
            i++; // {
            Map<String, Object> m = new LinkedHashMap<>();
            ws();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw new JsonException("expected string key", i);
                String key = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw new JsonException("expected ':'", i);
                i++;
                m.put(key, value(depth));
                ws();
                if (i >= s.length()) throw new JsonException("unterminated object", i);
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw new JsonException("expected ',' or '}'", i - 1);
            }
        }

        List<Object> array(int depth) {
            if (depth > MAX_DEPTH) throw new JsonException("nesting deeper than " + MAX_DEPTH, i);
            i++; // [
            List<Object> a = new ArrayList<>();
            ws();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return a;
            }
            while (true) {
                a.add(value(depth));
                ws();
                if (i >= s.length()) throw new JsonException("unterminated array", i);
                char c = s.charAt(i++);
                if (c == ']') return a;
                if (c != ',') throw new JsonException("expected ',' or ']'", i - 1);
            }
        }

        String string() {
            i++; // opening quote
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new JsonException("unterminated string", i);
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c < 0x20) throw new JsonException("unescaped control character in string", i - 1);
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (i >= s.length()) throw new JsonException("unterminated escape", i);
                char e = s.charAt(i++);
                switch (e) {
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        if (i + 4 > s.length()) throw new JsonException("bad \\u escape", i);
                        int cp = 0;
                        for (int k = 0; k < 4; k++) {
                            int d = Character.digit(s.charAt(i + k), 16);
                            if (d < 0 || s.charAt(i + k) > 'f') throw new JsonException("bad \\u escape", i + k);
                            cp = cp * 16 + d;
                        }
                        i += 4;
                        sb.append((char) cp); // surrogate pairs (two escapes) combine naturally in UTF-16
                    }
                    default -> throw new JsonException("bad escape '\\" + e + "'", i - 1);
                }
            }
        }

        BigDecimal number() {
            int start = i;
            if (s.charAt(i) == '-') i++;
            if (i >= s.length()) throw new JsonException("bad number", start);
            char c = s.charAt(i);
            if (c == '0') {
                i++;
            } else if (c >= '1' && c <= '9') {
                digits();
            } else {
                throw new JsonException("bad number", start);
            }
            if (i < s.length() && s.charAt(i) == '.') {
                i++;
                if (digits() == 0) throw new JsonException("bad number", start);
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                if (digits() == 0) throw new JsonException("bad number", start);
            }
            try {
                return new BigDecimal(s.substring(start, i));
            } catch (NumberFormatException ex) {
                throw new JsonException("number out of range", start);
            }
        }

        int digits() {
            int n = 0;
            while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
                n++;
            }
            return n;
        }
    }
}
