<?php

declare(strict_types=1);

namespace NepalPayments;

/**
 * Error raised by an adapter (TS `PaymentError`).
 *
 * `$errorCode` is the machine-readable code ("invalid_signature", "network_error", "http_502", ...).
 * Like PDOException, getCode() also returns that string.
 */
final class PaymentException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly ProviderId $provider,
        public readonly string $errorCode,
        public readonly ?int $httpStatus = null,
        public readonly mixed $details = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
        $this->code = $errorCode;
    }
}
