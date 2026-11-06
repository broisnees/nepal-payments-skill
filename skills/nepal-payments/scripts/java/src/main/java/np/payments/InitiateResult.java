package np.payments;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * What to do with the payer after {@link PaymentAdapter#initiate(InitiateInput)}:
 * {@link Redirect} the browser, render an auto-submitting {@link Form} ({@link Html#renderAutoSubmitForm(Form)}), or
 * show a {@link Qr} the payer scans. When {@code providerRef()} is non-null (Khalti pidx, NPS ProcessId, IME Pay
 * TokenId, NEPALPAY validationTraceId) persist it on the attempt;
 * verify() needs it.
 */
public sealed interface InitiateResult permits InitiateResult.Redirect, InitiateResult.Form, InitiateResult.Qr {

    /** "redirect", "form" or "qr", as in the TS port. */
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

    /**
     * Show a QR the payer scans from their own app (NEPALPAY QR). Render {@code qrString} with any QR library, or
     * {@code <img src="data:image/png;base64,...">} when the provider sent {@code qrImage}. Persist {@code providerRef}.
     *
     * @param qrImage base64 PNG, or null
     * @param raw     provider response, or null
     */
    record Qr(String qrString, String qrImage, String providerRef, Object raw) implements InitiateResult {
        public Qr {
            Objects.requireNonNull(qrString, "qrString");
            Objects.requireNonNull(providerRef, "providerRef");
        }

        @Override
        public String kind() {
            return "qr";
        }
    }
}
