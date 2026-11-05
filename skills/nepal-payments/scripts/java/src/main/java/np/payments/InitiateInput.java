package np.payments;

import java.util.Objects;

/**
 * Input for {@link PaymentAdapter#initiate(InitiateInput)}.
 *
 * @param orderId     unique per payment ATTEMPT (not per order); provider-safe charset [A-Za-z0-9-]
 *                    (use {@link Payments#newOrderId()})
 * @param amountPaisa integer paisa, computed server-side from your order
 * @param description shown to the payer where the provider supports it
 * @param returnUrl   where the provider sends the payer back (your server route); unused by connectIPS
 * @param failureUrl  separate failure URL for providers that have one; null = returnUrl
 * @param customer    optional payer details; null = none
 */
public record InitiateInput(
        String orderId,
        long amountPaisa,
        String description,
        String returnUrl,
        String failureUrl,
        Customer customer) {

    public InitiateInput {
        Objects.requireNonNull(orderId, "orderId");
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(returnUrl, "returnUrl");
    }

    public static InitiateInput of(String orderId, long amountPaisa, String description, String returnUrl) {
        return new InitiateInput(orderId, amountPaisa, description, returnUrl, null, null);
    }

    public InitiateInput withFailureUrl(String failureUrl) {
        return new InitiateInput(orderId, amountPaisa, description, returnUrl, failureUrl, customer);
    }

    public InitiateInput withCustomer(Customer customer) {
        return new InitiateInput(orderId, amountPaisa, description, returnUrl, failureUrl, customer);
    }

    /** failureUrl when set, else returnUrl (TS: {@code failureUrl ?? returnUrl}). */
    String failureUrlOrReturnUrl() {
        return failureUrl != null ? failureUrl : returnUrl;
    }
}
