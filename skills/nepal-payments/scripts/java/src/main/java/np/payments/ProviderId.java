package np.payments;

/** Supported providers. {@link #wire()} is the id used in config, routes and logs ("esewa", "khalti", ...). */
public enum ProviderId {
    ESEWA("esewa"),
    KHALTI("khalti"),
    FONEPAY("fonepay"),
    CONNECTIPS("connectips"),
    CYBERSOURCE("cybersource"),
    NPS("nps"),
    IMEPAY("imepay"),
    NEPALPAY("nepalpay"),
    HAMROPAY("hamropay"),
    GETPAY("getpay");

    private final String wire;

    ProviderId(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** Returns the provider for a wire id, e.g. a route parameter. */
    public static ProviderId fromWire(String id) {
        for (ProviderId p : values()) {
            if (p.wire.equals(id)) return p;
        }
        throw new IllegalArgumentException("unknown payment provider \"" + id + "\"");
    }

    @Override
    public String toString() {
        return wire;
    }
}
