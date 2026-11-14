"""Pure state-machine decision for a verify() result (references/architecture.md §2, §4)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# An attempt in one of these states may still move; anything else is final.
OPEN_STATUSES = ("initiated", "pending", "unknown")

# Final states where the money did NOT arrive. A later "paid" here is a late payment.
_CLOSED_UNPAID = ("failed", "canceled", "expired", "not_found")


@dataclass
class TransitionDecision:
    next: Optional[str]  # status to write, or None to write nothing
    review_required: bool  # stop automation, alert a human
    late_paid: bool  # provider says paid after we had closed the attempt
    reason: str


def decide_transition(
    prev: str,
    status: str,
    amount_paisa: Optional[int],
    stored_amount_paisa: int,
    attempt_age_s: float,
    session_window_s: float = 3600,
) -> TransitionDecision:
    """Decide what to write after verify().

    Apply `next` with a conditional UPDATE guarded by `prev`; fulfil only if next == "paid".
    """
    late_paid = status == "paid" and prev in _CLOSED_UNPAID
    if prev not in OPEN_STATUSES and not late_paid:
        return TransitionDecision(None, False, False, f"attempt already {prev}")

    if status == "paid" and amount_paisa != stored_amount_paisa:
        return TransitionDecision(
            "unknown", True, late_paid, _amount_problem(amount_paisa, stored_amount_paisa)
        )

    next_status = status
    if next_status == "not_found":
        if attempt_age_s < session_window_s:
            return TransitionDecision(None, False, False, "not_found inside session window")
        next_status = "expired"

    if next_status == prev:
        return TransitionDecision(None, False, False, "unchanged")

    if late_paid:
        reason = f"late payment (was {prev})"
    else:
        reason = f"{prev} -> {next_status}"
    return TransitionDecision(next_status, False, late_paid, reason)


def _amount_problem(amount_paisa: Optional[int], stored_amount_paisa: int) -> str:
    if amount_paisa is None:
        return "provider returned no amount for a paid status"
    return f"amount mismatch: stored {stored_amount_paisa}, provider {amount_paisa}"
