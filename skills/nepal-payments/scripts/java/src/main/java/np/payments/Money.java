package np.payments;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.regex.Pattern;

/** Money helpers. Keep money as integer paisa everywhere; convert only at the edge. */
public final class Money {
    static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern RUPEES = Pattern.compile("-?\\d+(\\.\\d+)?");

    private Money() {}

    /** Throws {@code invalid_amount} unless 0 < paisa <= 2^53-1 (TS Number.isSafeInteger). */
    public static void assertPaisa(long paisa, ProviderId provider) {
        if (paisa <= 0 || paisa > MAX_SAFE_INTEGER) {
            throw new PaymentException("amount must be a positive integer in paisa, got " + paisa, provider, "invalid_amount");
        }
    }

    /** 12345 -> "123.45", 10000 -> "100", 5 -> "0.05". Never use floats for money. */
    public static String paisaToRupees(long paisa) {
        long rupees = Math.abs(paisa / 100);
        long rem = Math.abs(paisa % 100);
        String sign = paisa < 0 ? "-" : "";
        return rem == 0 ? sign + rupees : sign + rupees + "." + (rem < 10 ? "0" : "") + rem;
    }

    /**
     * "123.45" | "1,000.0" | " 100 " -> paisa. Rounds half away from zero on the 3rd decimal.
     *
     * @throws IllegalArgumentException if the text is not a plain decimal rupee amount
     */
    public static long rupeesToPaisa(String rupees) {
        String s = Js.trim(rupees).replace(",", "");
        if (!RUPEES.matcher(s).matches()) throw new IllegalArgumentException("not a rupee amount: " + rupees);
        return toPaisa(new BigDecimal(s), rupees);
    }

    /** Exact decimal (e.g. a JSON number) -> paisa, same rounding. */
    public static long rupeesToPaisa(BigDecimal rupees) {
        return toPaisa(rupees, rupees.toPlainString());
    }

    /** 100.1 -> 10010, 1.005 -> 101: uses the shortest decimal text of the double, like JS String(x). */
    public static long rupeesToPaisa(double rupees) {
        return rupeesToPaisa(Js.numberToString(rupees));
    }

    /** JSON value (String or number) -> paisa. */
    static long rupeesToPaisaOf(Object v) {
        if (v instanceof String s) return rupeesToPaisa(s);
        if (v instanceof BigDecimal d) return rupeesToPaisa(d);
        if (v instanceof Number n) return rupeesToPaisa(n.doubleValue());
        throw new IllegalArgumentException("not a rupee amount: " + Js.string(v));
    }

    private static long toPaisa(BigDecimal d, Object original) {
        try {
            return d.movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact();
        } catch (ArithmeticException e) {
            throw new IllegalArgumentException("rupee amount out of range: " + original, e);
        }
    }
}
