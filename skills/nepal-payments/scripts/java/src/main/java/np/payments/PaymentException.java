package np.payments;

/**
 * A provider-level failure (TS {@code PaymentError}). {@code code} is stable and machine-readable
 * ("invalid_signature", "callback_mismatch", "network_error", "http_502", "unauthorized", ...).
 */
public class PaymentException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final ProviderId provider;
    private final String code;
    private final Integer httpStatus;
    private final transient Object details;

    public PaymentException(String message, ProviderId provider, String code) {
        this(message, provider, code, null, null);
    }

    public PaymentException(String message, ProviderId provider, String code, Integer httpStatus, Object details) {
        super(message, details instanceof Throwable t ? t : null);
        this.provider = provider;
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }

    public ProviderId provider() {
        return provider;
    }

    public String code() {
        return code;
    }

    /** HTTP status of the provider response (or 400 for rejected callbacks); null when not applicable. */
    public Integer httpStatus() {
        return httpStatus;
    }

    /** Provider response / offending callback for logs; null when none. Not serialized. */
    public Object details() {
        return details;
    }
}
