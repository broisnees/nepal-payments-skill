package np.payments;

/** Malformed JSON. {@code position()} is the 0-based char offset of the error. */
public class JsonException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    private final int position;

    public JsonException(String message, int position) {
        super(message + " at position " + position);
        this.position = position;
    }

    public int position() {
        return position;
    }
}
