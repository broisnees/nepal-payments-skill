"""Secure Acceptance hosts per environment. The form posts to {HOST}/pay."""

from __future__ import annotations

HOST = {
    "sandbox": "https://testsecureacceptance.cybersource.com",
    "production": "https://secureacceptance.cybersource.com",
}

PAY_PATH = "/pay"

# Reason codes that mean "the result is not known" (system error / timeout), not a decline.
UNCERTAIN_REASON_CODES = ("150", "151", "152")
