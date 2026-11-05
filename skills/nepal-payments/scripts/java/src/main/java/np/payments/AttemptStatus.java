package np.payments;

/**
 * Status as stored on a payment attempt row: every {@link PaymentStatus} plus {@link #INITIATED}
 * ("created, provider not yet heard from").
 */
public enum AttemptStatus {
    INITIATED("initiated"),
    PAID("paid"),
    PENDING("pending"),
    FAILED("failed"),
    CANCELED("canceled"),
    EXPIRED("expired"),
    REFUNDED("refunded"),
    PARTIALLY_REFUNDED("partially_refunded"),
    NOT_FOUND("not_found"),
    UNKNOWN("unknown");

    private final String wire;

    AttemptStatus(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public static AttemptStatus of(PaymentStatus s) {
        return valueOf(s.name());
    }

    public static AttemptStatus fromWire(String s) {
        for (AttemptStatus v : values()) {
            if (v.wire.equals(s)) return v;
        }
        throw new IllegalArgumentException("unknown attempt status \"" + s + "\"");
    }

    @Override
    public String toString() {
        return wire;
    }
}
