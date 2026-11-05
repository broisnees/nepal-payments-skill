package np.payments;

/** Provider environment. */
public enum Environment {
    SANDBOX,
    PRODUCTION;

    /** "production" or "live" means production; anything else (including null) is sandbox, as in the TS port. */
    public static Environment parse(String value) {
        return "production".equals(value) || "live".equals(value) ? PRODUCTION : SANDBOX;
    }
}
