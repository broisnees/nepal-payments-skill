"""IME Pay hosts per environment and API paths."""

from __future__ import annotations

BASE = {
    "sandbox": "https://stg.imepay.com.np:7979",
    "production": "https://payment.imepay.com.np:7979",
}

GET_TOKEN_PATH = "/api/Web/GetToken"
RECHECK_PATH = "/api/Web/Recheck"
CHECKOUT_PATH = "/WebCheckout/Checkout"
