<?php

declare(strict_types=1);

namespace NepalPayments;

final class VerifyResult implements \JsonSerializable
{
    /**
     * @param string $orderId Your order / transaction id as known to the provider.
     * @param int|null $amountPaisa Amount the PROVIDER says was paid, in paisa. null if the provider doesn't say.
     * @param string|null $transactionId Provider's final transaction id (eSewa ref_id, Khalti transaction_id, ...). Store it.
     * @param mixed $raw Untouched provider response, for audit logs.
     */
    public function __construct(
        public readonly ProviderId $provider,
        public readonly PaymentStatus $status,
        public readonly string $orderId,
        public readonly ?int $amountPaisa,
        public readonly ?string $transactionId,
        public readonly mixed $raw,
    ) {
    }

    /** @return array{provider: string, status: string, orderId: string, amountPaisa: int|null, transactionId: string|null, raw: mixed} */
    public function jsonSerialize(): array
    {
        return [
            'provider' => $this->provider->value,
            'status' => $this->status->value,
            'orderId' => $this->orderId,
            'amountPaisa' => $this->amountPaisa,
            'transactionId' => $this->transactionId,
            'raw' => $this->raw,
        ];
    }
}
