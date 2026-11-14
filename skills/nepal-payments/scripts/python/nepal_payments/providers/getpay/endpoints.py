"""GetPay URLs per environment, the status map, and origin handling for callback URLs."""

from __future__ import annotations

import urllib.parse

from ...core.types import PaymentStatus

# Base for the server calls; append /merchant-status or /transaction-statement.
BASE = {
    "sandbox": "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
    "production": "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
}

# Browser SDK; defines `new GetPay(options)`.
BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"

TXN_STATUS: dict[str, PaymentStatus] = {
    "SUCCESS": "paid",
    "APPROVED": "paid",
    "FAILED": "failed",
    "FAILURE": "failed",
    "DECLINED": "failed",
    "PENDING": "pending",
    "CANCELLED": "canceled",
    "CANCELED": "canceled",
}

_DEFAULT_PORTS = {"http": 80, "https": 443}


def origin(url: str) -> str:
    """WHATWG URL origin: scheme://host[:port], default port dropped."""
    parts = urllib.parse.urlsplit(url)
    if not parts.scheme or not parts.hostname:
        raise ValueError(f"invalid URL: {url!r}")
    scheme, host, port = parts.scheme.lower(), parts.hostname, parts.port
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    if port is None or _DEFAULT_PORTS.get(scheme) == port:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"
