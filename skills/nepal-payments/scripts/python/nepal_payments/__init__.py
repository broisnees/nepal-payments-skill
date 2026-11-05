"""nepal_payments — one interface over Nepali payment providers (stdlib only; `cryptography` for connectIPS).

    payments = create_payments(config_from_env())
    form = payments["esewa"].initiate(order_id=..., amount_paisa=..., description=..., return_url=...)
    result = payments["esewa"].verify(order_id=..., amount_paisa=..., callback=request.args)
"""

from __future__ import annotations

import os
import secrets
import time
from typing import Mapping, Optional

from .connectips import ConnectIps
from .core import (OPEN_STATUSES, FormResult, PaymentError, RedirectResult, TransitionDecision, VerifyResult,
                   decide_transition, paisa_to_rupees, render_auto_submit_form, rupees_to_paisa)
from .cybersource import CyberSource
from .esewa import Esewa
from .fonepay import Fonepay
from .imepay import ImePay
from .khalti import Khalti
from .nps import Nps

__all__ = ["Esewa", "Khalti", "Fonepay", "ConnectIps", "CyberSource", "Nps", "ImePay", "PaymentError",
           "VerifyResult", "RedirectResult", "FormResult", "render_auto_submit_form", "paisa_to_rupees",
           "rupees_to_paisa", "create_payments", "config_from_env", "new_order_id", "decide_transition",
           "TransitionDecision", "OPEN_STATUSES"]

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def new_order_id(prefix: str = "P") -> str:
    """<= 20 chars [A-Z0-9]: fits connectIPS TXNID (20), Fonepay PRN (25), eSewa uuid charset, etc."""
    n, t = int(time.time() * 1000), ""
    while n:
        n, r = divmod(n, 36)
        t = _ALPHABET[r] + t
    return (prefix + t + "".join(secrets.choice(_ALPHABET) for _ in range(10)))[:20]


def _mode(v: Optional[str]) -> str:
    return "production" if v in ("production", "live") else "sandbox"


def create_payments(cfg: Mapping[str, dict]) -> dict:
    """cfg: {"esewa": {...Esewa kwargs}, "khalti": {...}, ...} -> {"esewa": Esewa(...), ...}"""
    classes = {"esewa": Esewa, "khalti": Khalti, "fonepay": Fonepay, "connectips": ConnectIps,
               "cybersource": CyberSource, "nps": Nps, "imepay": ImePay}
    return {name: classes[name](**kwargs) for name, kwargs in cfg.items()}


def config_from_env(env: Optional[Mapping[str, str]] = None) -> dict:
    """Enable each provider whose required env vars are set. See references/env.md."""
    e = os.environ if env is None else env
    cfg: dict = {}
    if e.get("ESEWA_PRODUCT_CODE") and e.get("ESEWA_SECRET_KEY"):
        cfg["esewa"] = {"env": _mode(e.get("ESEWA_ENV")), "product_code": e["ESEWA_PRODUCT_CODE"],
                        "secret_key": e["ESEWA_SECRET_KEY"],
                        "intent_product_code": e.get("ESEWA_INTENT_PRODUCT_CODE"),
                        "intent_access_key": e.get("ESEWA_INTENT_ACCESS_KEY"),
                        "intent_base_url": e.get("ESEWA_INTENT_BASE_URL")}
    if e.get("KHALTI_SECRET_KEY") and e.get("KHALTI_WEBSITE_URL"):
        cfg["khalti"] = {"env": _mode(e.get("KHALTI_ENV")), "secret_key": e["KHALTI_SECRET_KEY"],
                         "website_url": e["KHALTI_WEBSITE_URL"]}
    if e.get("FONEPAY_MERCHANT_CODE") and e.get("FONEPAY_SECRET_KEY"):
        cfg["fonepay"] = {"env": _mode(e.get("FONEPAY_ENV")), "merchant_code": e["FONEPAY_MERCHANT_CODE"],
                          "secret_key": e["FONEPAY_SECRET_KEY"], "username": e.get("FONEPAY_USERNAME"),
                          "password": e.get("FONEPAY_PASSWORD")}
    if e.get("CONNECTIPS_MERCHANT_ID") and e.get("CONNECTIPS_APP_ID") and e.get("CONNECTIPS_PRIVATE_KEY_PEM"):
        cfg["connectips"] = {"env": _mode(e.get("CONNECTIPS_ENV")), "merchant_id": e["CONNECTIPS_MERCHANT_ID"],
                             "app_id": e["CONNECTIPS_APP_ID"], "app_name": e.get("CONNECTIPS_APP_NAME", ""),
                             "app_password": e.get("CONNECTIPS_APP_PASSWORD", ""),
                             "private_key_pem": e["CONNECTIPS_PRIVATE_KEY_PEM"].replace("\\n", "\n").encode()}
    if e.get("CYBERSOURCE_PROFILE_ID") and e.get("CYBERSOURCE_ACCESS_KEY") and e.get("CYBERSOURCE_SECRET_KEY"):
        cfg["cybersource"] = {"env": _mode(e.get("CYBERSOURCE_ENV")), "profile_id": e["CYBERSOURCE_PROFILE_ID"],
                              "access_key": e["CYBERSOURCE_ACCESS_KEY"], "secret_key": e["CYBERSOURCE_SECRET_KEY"],
                              "currency": e.get("CYBERSOURCE_CURRENCY", "NPR")}
    if e.get("NPS_MERCHANT_ID") and e.get("NPS_SECRET_KEY"):
        cfg["nps"] = {"env": _mode(e.get("NPS_ENV")), "merchant_id": e["NPS_MERCHANT_ID"],
                      "merchant_name": e.get("NPS_MERCHANT_NAME", ""), "api_username": e.get("NPS_API_USERNAME", ""),
                      "api_password": e.get("NPS_API_PASSWORD", ""), "secret_key": e["NPS_SECRET_KEY"]}
    if e.get("IMEPAY_MERCHANT_CODE") and e.get("IMEPAY_USERNAME"):
        cfg["imepay"] = {"env": _mode(e.get("IMEPAY_ENV")), "merchant_code": e["IMEPAY_MERCHANT_CODE"],
                         "username": e["IMEPAY_USERNAME"], "password": e.get("IMEPAY_PASSWORD", ""),
                         "module": e.get("IMEPAY_MODULE", "")}
    return cfg
