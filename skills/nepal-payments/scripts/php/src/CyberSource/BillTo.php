<?php

declare(strict_types=1);

namespace NepalPayments\CyberSource;

final class BillTo
{
    /**
     * @param string $country ISO 3166 alpha-2, e.g. "NP".
     * @param string|null $postalCode Required only for US/CA.
     * @param string|null $state Required only for US/CA.
     */
    public function __construct(
        public readonly string $forename,
        public readonly string $surname,
        public readonly string $email,
        public readonly string $addressLine1,
        public readonly string $city,
        public readonly string $country,
        public readonly ?string $phone = null,
        public readonly ?string $postalCode = null,
        public readonly ?string $state = null,
    ) {
    }
}
