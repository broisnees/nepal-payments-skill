package np.payments;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Input for {@link PaymentAdapter#verify(VerifyInput)}. Every value except {@code callback} comes from YOUR database.
 *
 * @param orderId     the attempt id you sent to the provider
 * @param amountPaisa the amount YOU stored for this attempt
 * @param providerRef the providerRef returned by initiate() (Khalti pidx, NPS ProcessId, IME Pay TokenId, ...), from
 *                    your DB; null if the provider has none
 * @param callback    raw query/body params the provider sent to your return URL; null if none (reconciliation)
 */
public record VerifyInput(String orderId, long amountPaisa, String providerRef, Map<String, String> callback) {

    public VerifyInput {
        Objects.requireNonNull(orderId, "orderId");
        if (callback != null) callback = Collections.unmodifiableMap(new LinkedHashMap<>(callback));
    }

    public static VerifyInput of(String orderId, long amountPaisa) {
        return new VerifyInput(orderId, amountPaisa, null, null);
    }

    public VerifyInput withProviderRef(String providerRef) {
        return new VerifyInput(orderId, amountPaisa, providerRef, callback);
    }

    public VerifyInput withCallback(Map<String, String> callback) {
        return new VerifyInput(orderId, amountPaisa, providerRef, callback);
    }
}
