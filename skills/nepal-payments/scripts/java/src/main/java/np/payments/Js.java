package np.payments;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The few JavaScript coercions the TS adapters rely on (truthiness, String(x), Number(x), trim, encodeURIComponent),
 * applied to parsed JSON values, so provider edge cases behave exactly like the TS source of truth.
 */
final class Js {
    /** JS {@code \s}: WhiteSpace + LineTerminator. */
    static final String WS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";

    private static final Pattern DECIMAL = Pattern.compile("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?");

    private Js() {}

    static boolean isWhitespace(char c) {
        switch (c) {
            case '\t', '\n', 0x0B, '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                return true;
            default:
                return c >= 0x2000 && c <= 0x200A;
        }
    }

    /** String.prototype.trim. */
    static String trim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isWhitespace(s.charAt(start))) start++;
        while (end > start && isWhitespace(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    /** s.slice(0, n). */
    static String slice(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    /** Boolean(v). */
    static boolean truthy(Object v) {
        if (v == null) return false;
        if (v instanceof Boolean b) return b;
        if (v instanceof String s) return !s.isEmpty();
        if (v instanceof BigDecimal d) return d.signum() != 0;
        if (v instanceof Number n) {
            double d = n.doubleValue();
            return d != 0 && !Double.isNaN(d);
        }
        return true;
    }

    /** String(v) for JSON values. */
    static String string(Object v) {
        if (v == null) return "null";
        if (v instanceof String s) return s;
        if (v instanceof BigDecimal || v instanceof Double || v instanceof Float || v instanceof BigInteger) {
            return numberToString(((Number) v).doubleValue());
        }
        if (v instanceof Number || v instanceof Boolean) return v.toString();
        if (v instanceof List<?> l) return join(l, ",");
        if (v instanceof Map) return "[object Object]";
        return v.toString();
    }

    /** `${v ?? ""}`. */
    static String stringOrEmpty(Object v) {
        return v == null ? "" : string(v);
    }

    /** Array.prototype.join: null elements become "". */
    static String join(List<?> list, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(sep);
            Object e = list.get(i);
            if (e != null) sb.append(string(e));
        }
        return sb.toString();
    }

    /**
     * Provider id values as text. Strings pass through; integral JSON numbers keep every digit (JS would round ids above
     * 2^53); null stays null.
     */
    static String id(Object v) {
        if (v == null) return null;
        if (v instanceof BigDecimal d) {
            BigDecimal s = d.stripTrailingZeros();
            if (s.scale() <= 0) return s.toBigInteger().toString();
        }
        return string(v);
    }

    /** Number.prototype.toString() (shortest round-trip digits, JS exponent rules). */
    static String numberToString(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        BigDecimal bd = new BigDecimal(Double.toString(d)).stripTrailingZeros();
        double abs = Math.abs(d);
        if (abs >= 1e-7 && abs < 1e21) return bd.toPlainString();
        String digits = bd.unscaledValue().abs().toString();
        int exp = digits.length() - 1 - bd.scale();
        String mantissa = digits.length() == 1 ? digits : digits.charAt(0) + "." + digits.substring(1);
        return (d < 0 ? "-" : "") + mantissa + "e" + (exp >= 0 ? "+" : "-") + Math.abs(exp);
    }

    /** Number(v) for JSON values. */
    static double toNumber(Object v) {
        if (v == null) return 0;
        if (v instanceof Boolean b) return b ? 1 : 0;
        if (v instanceof Number n) return n.doubleValue();
        if (v instanceof String s) {
            String t = trim(s);
            if (t.isEmpty()) return 0;
            switch (t) {
                case "Infinity", "+Infinity":
                    return Double.POSITIVE_INFINITY;
                case "-Infinity":
                    return Double.NEGATIVE_INFINITY;
                default:
                    break;
            }
            if (t.length() > 2 && t.charAt(0) == '0') {
                int radix = switch (t.charAt(1)) {
                    case 'x', 'X' -> 16;
                    case 'o', 'O' -> 8;
                    case 'b', 'B' -> 2;
                    default -> 0;
                };
                if (radix != 0) {
                    try {
                        return new BigInteger(t.substring(2), radix).doubleValue();
                    } catch (NumberFormatException e) {
                        return Double.NaN;
                    }
                }
            }
            return DECIMAL.matcher(t).matches() ? Double.parseDouble(t) : Double.NaN;
        }
        return toNumber(string(v));
    }

    /** obj?.[key] for parsed JSON: only objects have properties. */
    static Object get(Object obj, String key) {
        return obj instanceof Map<?, ?> m ? m.get(key) : null;
    }

    /** encodeURIComponent. */
    static String encodeURIComponent(String s) {
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xFF);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".indexOf(c) >= 0) {
                sb.append(c);
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xF, 16)))
                        .append(Character.toUpperCase(Character.forDigit(b & 0xF, 16)));
            }
        }
        return sb.toString();
    }

    /** "a,b".split(",") with JS semantics (trailing empty strings kept). */
    static List<String> split(String s, char sep) {
        List<String> out = new ArrayList<>();
        int from = 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == sep) {
                out.add(s.substring(from, i));
                from = i + 1;
            }
        }
        out.add(s.substring(from));
        return out;
    }
}
