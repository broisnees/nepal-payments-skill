<?php

declare(strict_types=1);

namespace NepalPayments;

enum Environment: string
{
    case Sandbox = 'sandbox';
    case Production = 'production';

    /** "production" or "live" -> Production; anything else (including null) -> Sandbox. */
    public static function fromMode(?string $value): self
    {
        return $value === 'production' || $value === 'live' ? self::Production : self::Sandbox;
    }
}
