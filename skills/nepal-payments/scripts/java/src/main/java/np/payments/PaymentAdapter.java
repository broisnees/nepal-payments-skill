package np.payments;

import java.util.Map;
import java.util.Optional;

/**
 * One provider. Implementations are immutable and thread-safe. All calls are blocking (fine on virtual threads and in
 * Spring MVC). Failures throw {@link PaymentException}.
 */
public interface PaymentAdapter {

    ProviderId id();

    /** Start a payment attempt. */
    InitiateResult initiate(InitiateInput input);

    /** Server-to-server confirmation. Never trust callback params alone. */
    VerifyResult verify(VerifyInput input);

    /** Extract YOUR order id from return-URL params so you can load the attempt. */
    Optional<String> orderIdFromCallback(Map<String, String> params);
}
