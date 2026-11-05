<?php

declare(strict_types=1);

namespace NepalPayments;

final class Customer
{
    public function __construct(
        public readonly ?string $name = null,
        public readonly ?string $email = null,
        public readonly ?string $phone = null,
    ) {
    }

    /** Only the fields that are set (JSON.stringify drops undefined ones). */
    public function toObject(): \stdClass
    {
        return (object) array_filter(
            ['name' => $this->name, 'email' => $this->email, 'phone' => $this->phone],
            static fn (?string $v): bool => $v !== null,
        );
    }
}
