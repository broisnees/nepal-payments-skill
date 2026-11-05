package np.payments;

/**
 * Normalized result of a server-to-server verification.
 *
 * @param provider      the provider that answered
 * @param status        normalized status
 * @param orderId       your order / transaction id as known to the provider
 * @param amountPaisa   amount the PROVIDER says was paid, in paisa (1 NPR = 100 paisa); null if the provider doesn't say
 * @param transactionId provider's final transaction id (eSewa ref_id, Khalti transaction_id, ...); store it, support
 *                      and refunds need it; null if none
 * @param raw           untouched provider response for audit logs (parsed JSON: Map / List / String / BigDecimal /
 *                      Boolean / null)
 */
public record VerifyResult(
        ProviderId provider,
        PaymentStatus status,
        String orderId,
        Long amountPaisa,
        String transactionId,
        Object raw) {}
