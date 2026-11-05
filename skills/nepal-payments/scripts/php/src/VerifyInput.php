<?php

declare(strict_types=1);

namespace NepalPayments;

use NepalPayments\Internal\Js;

final class VerifyInput
{
    /** @var array<string, string>|null */
    public readonly ?array $callback;

    /**
     * @param string $orderId The attempt id you stored.
     * @param int $amountPaisa The amount YOU stored for this attempt.
     * @param string|null $providerRef The providerRef returned by initiate() (Khalti pidx, NPS ProcessId, IME TokenId...), from YOUR db.
     * @param array<array-key, mixed>|null $callback Raw query/body params the provider sent to your return URL.
     *        Normalized to string => string: null (Laravel's ConvertEmptyStringsToNull) becomes "", numbers become
     *        strings, and array/bool/object values are dropped.
     */
    public function __construct(
        public readonly string $orderId,
        public readonly int $amountPaisa,
        public readonly ?string $providerRef = null,
        ?array $callback = null,
    ) {
        $this->callback = $callback === null ? null : Js::stringMap($callback);
    }
}
