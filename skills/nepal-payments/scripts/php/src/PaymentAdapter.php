<?php

declare(strict_types=1);

namespace NepalPayments;

interface PaymentAdapter
{
    public function id(): ProviderId;

    /** @throws PaymentException */
    public function initiate(InitiateInput $input): InitiateResult;

    /**
     * Server-to-server confirmation. Never trust callback params alone.
     *
     * @throws PaymentException
     */
    public function verify(VerifyInput $input): VerifyResult;

    /**
     * Extract YOUR order id from return-URL params so you can load the attempt.
     *
     * @param array<array-key, mixed> $params
     */
    public function orderIdFromCallback(array $params): ?string;
}
