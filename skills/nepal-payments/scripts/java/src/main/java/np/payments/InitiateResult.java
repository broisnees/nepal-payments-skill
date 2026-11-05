package np.payments;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * What to do with the payer after {@link PaymentAdapter#initiate(InitiateInput)}:
 * {@link Redirect} the browser, or render an auto-submitting {@link Form} ({@link Html#renderAutoSubmitForm(Form)}).
 * When {@code providerRef()} is non-null (Khalti pidx, NPS ProcessId, IME Pay TokenId) persist it on the attempt;
 * verify() needs it.
 */
public sealed interface InitiateResult permits InitiateResult.Redirect, InitiateResult.Form {

    /** "redirect" or "form", as in the TS port. */
    String kind();

    /** Provider reference to persist, or null. */
    String providerRef();

    /**
     * Redirect the browser (or open a WebView / Custom Tab) to {@code url}.
     *
     * @param expiresAt provider expiry timestamp as sent (Khalti), or null
     * @param raw       provider response, or null
     */
    record Redirect(String url, String providerRef, String expiresAt, Object raw) implements InitiateResult {
        public Redirect {
            Objects.requireNonNull(url, "url");
        }

        public Redirect(String url) {
            this(url, null, null, null);
        }

        @Override
        public String kind() {
            return "redirect";
        }
    }

    /**
     * Auto-submitting HTML form that POSTs {@code fields} to {@code action}.
     *
     * @param method  always "POST"
     * @param fields  form fields in order (unmodifiable)
     * @param enctype null = application/x-www-form-urlencoded; NPS requires "multipart/form-data"
     */
    record Form(String action, String method, Map<String, String> fields, String enctype, String providerRef)
            implements InitiateResult {
        public Form {
            Objects.requireNonNull(action, "action");
            Objects.requireNonNull(method, "method");
            fields = Collections.unmodifiableMap(new LinkedHashMap<>(fields));
        }

        public Form(String action, Map<String, String> fields) {
            this(action, "POST", fields, null, null);
        }

        @Override
        public String kind() {
            return "form";
        }
    }
}
