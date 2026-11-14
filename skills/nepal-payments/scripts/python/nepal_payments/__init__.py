"""nepal_payments — one interface over Nepali payment providers.

Standard library only; `cryptography` is needed for connectIPS and NEPALPAY QR.

    payments = create_payments(config_from_env())
    form = payments["esewa"].initiate(
        order_id=..., amount_paisa=..., description=..., return_url=...
    )
    result = payments["esewa"].verify(order_id=..., amount_paisa=..., callback=request.args)

Layout: core/ holds shared primitives, providers/<id>/ one gateway each (see CONTRIBUTING.md).
"""

from __future__ import annotations

import os
import secrets
import time
from typing import Any, Mapping, Optional

from .core import (
    OPEN_STATUSES,
    FormResult,
    PaymentError,
    QrResult,
    RedirectResult,
    SdkResult,
    TransitionDecision,
    VerifyResult,
    decide_transition,
    paisa_to_rupees,
    render_auto_submit_form,
    rupees_to_paisa,
)
from .providers import (
    ENV_READERS,
    PROVIDER_CLASSES,
    ConnectIps,
    CyberSource,
    Esewa,
    Fonepay,
    GetPay,
    HamroPay,
    ImePay,
    Khalti,
    NepalPay,
    Nps,
)
from .providers.getpay import get_pay_decode_token, get_pay_opr_secret
from .providers.hamropay import HAMROPAY_MAX_PAISA, HAMROPAY_MIN_PAISA, hamro_pay_sign
from .providers.nepalpay import nepal_pay_confirmation_string, nepal_pay_token_string

__all__ = [
    "HAMROPAY_MAX_PAISA",
    "HAMROPAY_MIN_PAISA",
    "OPEN_STATUSES",
    "ConnectIps",
    "CyberSource",
    "Esewa",
    "Fonepay",
    "FormResult",
    "GetPay",
    "HamroPay",
    "ImePay",
    "Khalti",
    "NepalPay",
    "Nps",
    "PaymentError",
    "QrResult",
    "RedirectResult",
    "SdkResult",
    "TransitionDecision",
    "VerifyResult",
    "config_from_env",
    "create_payments",
    "decide_transition",
    "get_pay_decode_token",
    "get_pay_opr_secret",
    "hamro_pay_sign",
    "nepal_pay_confirmation_string",
    "nepal_pay_token_string",
    "new_order_id",
    "paisa_to_rupees",
    "render_auto_submit_form",
    "rupees_to_paisa",
]

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def new_order_id(prefix: str = "P") -> str:
    """<= 20 chars [A-Z0-9]: fits connectIPS TXNID (20), Fonepay PRN (25), eSewa uuid charset, etc.

    Base-36 milliseconds (sortable) followed by 10 random characters.
    """
    millis = int(time.time() * 1000)
    timestamp = ""
    while millis:
        millis, digit = divmod(millis, 36)
        timestamp = _ALPHABET[digit] + timestamp
    random_part = "".join(secrets.choice(_ALPHABET) for _ in range(10))
    return (prefix + timestamp + random_part)[:20]


def create_payments(cfg: Mapping[str, dict]) -> dict[str, Any]:
    """cfg: {"esewa": {...Esewa kwargs}, "khalti": {...}, ...} -> {"esewa": Esewa(...), ...}"""
    return {name: PROVIDER_CLASSES[name](**kwargs) for name, kwargs in cfg.items()}


def config_from_env(env: Optional[Mapping[str, str]] = None) -> dict[str, dict[str, Any]]:
    """Enable each provider whose required env vars are set. See references/env.md.

    Each provider's variables are read by providers/<id>/config.py:from_env().
    """
    source = os.environ if env is None else env
    cfg: dict[str, dict[str, Any]] = {}
    for name, read in ENV_READERS.items():
        kwargs = read(source)
        if kwargs is not None:
            cfg[name] = kwargs
    return cfg
