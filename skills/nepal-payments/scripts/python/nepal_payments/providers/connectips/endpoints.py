"""connectIPS hosts per environment and the paths under them."""

from __future__ import annotations

BASE = {"sandbox": "https://uat.connectips.com", "production": "https://login.connectips.com"}

# Browser form POST target (relative to BASE).
LOGIN_PAGE_PATH = "/connectipswebgw/loginpage"

# Server-to-server validation APIs (relative to BASE); append "validatetxn" or "gettxndetail".
CREDITOR_API_PATH = "/connectipswebws/api/creditor/"
