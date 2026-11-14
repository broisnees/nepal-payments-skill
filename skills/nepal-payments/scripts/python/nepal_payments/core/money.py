"""Money: integer paisa everywhere; convert only at the edge."""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Union

from .errors import PaymentError

# Decimal() alone would also accept "1e3", "+5" and "NaN".
_RUPEES = re.compile(r"-?\d+(\.\d+)?")


def assert_paisa(paisa: int, provider: str) -> None:
    """Raise PaymentError("invalid_amount") unless `paisa` is a positive int (bools rejected)."""
    if not isinstance(paisa, int) or isinstance(paisa, bool) or paisa <= 0:
        raise PaymentError(
            f"amount must be a positive integer in paisa, got {paisa!r}",
            provider,
            "invalid_amount",
        )


def paisa_to_rupees(paisa: int) -> str:
    """Shortest rupee string: 12345 -> '123.45', 10000 -> '100'."""
    rupees, rem = divmod(abs(paisa), 100)
    sign = "-" if paisa < 0 else ""
    if rem == 0:
        return f"{sign}{rupees}"
    return f"{sign}{rupees}.{rem:02d}"


def paisa_to_rupees_2dp(paisa: int) -> str:
    """Rupees with exactly two decimals: 10000 -> '100.00'. For positive amounts only."""
    return f"{paisa // 100}.{paisa % 100:02d}"


def rupees_to_paisa(rupees: Union[str, int, float, Decimal]) -> int:
    """'123.45' | 123.45 | '100' -> paisa. Rounds half away from zero on the 3rd decimal."""
    text = str(rupees).strip().replace(",", "")
    if not _RUPEES.fullmatch(text):
        raise ValueError(f"not a rupee amount: {rupees!r}")
    amount = Decimal(text)
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
