<?php

declare(strict_types=1);

namespace NepalPayments\Http;

/** Network-level failure (DNS, connect, TLS, timeout). Any HTTP status, including 5xx, is a response, not this. */
final class TransportException extends \RuntimeException
{
}
