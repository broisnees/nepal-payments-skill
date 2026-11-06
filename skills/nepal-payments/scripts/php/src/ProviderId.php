<?php

declare(strict_types=1);

namespace NepalPayments;

/** Provider identifiers (same wire strings as the TypeScript `ProviderId`). */
enum ProviderId: string
{
    case Esewa = 'esewa';
    case Khalti = 'khalti';
    case Fonepay = 'fonepay';
    case ConnectIps = 'connectips';
    case CyberSource = 'cybersource';
    case Nps = 'nps';
    case ImePay = 'imepay';
    case NepalPay = 'nepalpay';
}
