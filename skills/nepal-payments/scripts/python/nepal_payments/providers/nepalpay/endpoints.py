"""NPI hosts per environment, paths, and the status codes that decide a payment."""

from __future__ import annotations

BASE = {
    "sandbox": "https://devopennpi.connectips.com",
    "production": "https://opennpi.connectips.com",
}

OAUTH_TOKEN_PATH = "/oauth/token"
GENERATE_QR_PATH = "/qr/generateQR"
TXN_REPORT_PATH = "/nQR/v1/merchanttxnreport"

# STOMP destinations of the WebSocket channel.
WS_SUBSCRIBE = "/user/nqrws/check-txn-status"
WS_SEND = "/nqrws/check-txn-status"

NPR = 524  # ISO 4217 numeric currency code

# Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
DEBIT_OK = "000"
CREDIT_OK = {"000", "999", "DEFER"}

GENERATE_QR_OK = "000"
REPORT_OK = ("200", "000")
REPORT_NOT_FOUND = "E010"  # record not found
