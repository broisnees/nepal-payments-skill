package np.payments;

/** Normalized payment state. Every provider status maps onto exactly one of these. */
public enum PaymentStatus {
    /** Money captured; safe to fulfil. */
    PAID("paid"),
    /** Provider has not settled yet; re-check later, do NOT fulfil. */
    PENDING("pending"),
    /** Declined / error; safe to let the user retry with a NEW order id. */
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

    private final String wire;

    PaymentStatus(String wire) {
        this.wire = wire;
    }

    /** The TypeScript/Python string ("paid", "partially_refunded", ...). Store this in your DB. */
    public String wire() {
        return wire;
    }

    public static PaymentStatus fromWire(String s) {
        for (PaymentStatus v : values()) {
            if (v.wire.equals(s)) return v;
        }
        throw new IllegalArgumentException("unknown payment status \"" + s + "\"");
    }

    @Override
    public String toString() {
        return wire;
    }
}
