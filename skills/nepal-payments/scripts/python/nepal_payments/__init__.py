"""nepal_payments — one interface over Nepali payment providers (stdlib only; `cryptography` for connectIPS and NEPALPAY QR).

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
from .core import (OPEN_STATUSES, FormResult, PaymentError, QrResult, RedirectResult, SdkResult, TransitionDecision,
                   VerifyResult, decide_transition, paisa_to_rupees, render_auto_submit_form, rupees_to_paisa)
from .cybersource import CyberSource
from .esewa import Esewa
from .fonepay import Fonepay
from .getpay import GetPay, get_pay_decode_token, get_pay_opr_secret
from .hamropay import HAMROPAY_MAX_PAISA, HAMROPAY_MIN_PAISA, HamroPay, hamro_pay_sign
from .imepay import ImePay
from .khalti import Khalti
from .nepalpay import NepalPay, nepal_pay_confirmation_string, nepal_pay_token_string
from .nps import Nps

__all__ = ["Esewa", "Khalti", "Fonepay", "ConnectIps", "CyberSource", "Nps", "ImePay", "NepalPay", "HamroPay", "GetPay",
           "PaymentError", "VerifyResult", "RedirectResult", "FormResult", "QrResult", "SdkResult", "hamro_pay_sign",
           "HAMROPAY_MIN_PAISA", "HAMROPAY_MAX_PAISA", "get_pay_opr_secret", "get_pay_decode_token", "nepal_pay_token_string", "nepal_pay_confirmation_string", "render_auto_submit_form", "paisa_to_rupees",
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
               "cybersource": CyberSource, "nps": Nps, "imepay": ImePay, "nepalpay": NepalPay,
               "hamropay": HamroPay, "getpay": GetPay}
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
    if (e.get("NEPALPAY_ACQUIRER_ID") and e.get("NEPALPAY_MERCHANT_ID") and e.get("NEPALPAY_USERNAME")
            and e.get("NEPALPAY_PRIVATE_KEY_PEM")):
        cfg["nepalpay"] = {"env": _mode(e.get("NEPALPAY_ENV")), "acquirer_id": e["NEPALPAY_ACQUIRER_ID"],
                           "merchant_id": e["NEPALPAY_MERCHANT_ID"], "merchant_name": e.get("NEPALPAY_MERCHANT_NAME", ""),
                           "merchant_category_code": e.get("NEPALPAY_MCC", ""),
                           "merchant_city": e.get("NEPALPAY_MERCHANT_CITY", "Kathmandu"),
                           "merchant_postal_code": e.get("NEPALPAY_MERCHANT_POSTAL_CODE", "44600"),
                           "store_label": e.get("NEPALPAY_STORE_LABEL", "Store1"),
                           "terminal_label": e.get("NEPALPAY_TERMINAL_LABEL"),
                           "username": e["NEPALPAY_USERNAME"], "password": e.get("NEPALPAY_PASSWORD", ""),
                           "private_key_pem": e["NEPALPAY_PRIVATE_KEY_PEM"].replace("\\n", "\n").encode()}
        if e.get("NEPALPAY_CLIENT_ID"):
            cfg["nepalpay"].update(auth="oauth", client_id=e["NEPALPAY_CLIENT_ID"],
                                   client_secret=e.get("NEPALPAY_CLIENT_SECRET", ""))
        if e.get("NEPALPAY_NCHL_PUBLIC_KEY_PEM"):
            cfg["nepalpay"]["nchl_public_key_pem"] = e["NEPALPAY_NCHL_PUBLIC_KEY_PEM"].replace("\\n", "\n").encode()
        if e.get("NEPALPAY_WS_URL"):
            cfg["nepalpay"].update(ws_url=e["NEPALPAY_WS_URL"], ws_username=e.get("NEPALPAY_WS_USERNAME"),
                                   ws_api_token=e.get("NEPALPAY_WS_API_TOKEN"))
    if (e.get("HAMROPAY_MERCHANT_ID") and e.get("HAMROPAY_CLIENT_ID") and e.get("HAMROPAY_CLIENT_API_KEY")
            and e.get("HAMROPAY_CLIENT_SECRET")):
        cfg["hamropay"] = {"env": _mode(e.get("HAMROPAY_ENV")), "merchant_id": e["HAMROPAY_MERCHANT_ID"],
                           "client_id": e["HAMROPAY_CLIENT_ID"], "client_api_key": e["HAMROPAY_CLIENT_API_KEY"],
                           "client_secret": e["HAMROPAY_CLIENT_SECRET"],
                           "webhook_secret": e.get("HAMROPAY_WEBHOOK_SECRET"),
                           "api_base_url": e.get("HAMROPAY_API_BASE_URL"), "gateway_url": e.get("HAMROPAY_GATEWAY_URL")}
    if e.get("GETPAY_PAP_INFO") and e.get("GETPAY_OPR_KEY") and e.get("GETPAY_WEBSITE_DOMAIN"):
        cfg["getpay"] = {"env": _mode(e.get("GETPAY_ENV")), "pap_info": e["GETPAY_PAP_INFO"],
                         "opr_key": e["GETPAY_OPR_KEY"], "ins_key": e.get("GETPAY_INS_KEY"),
                         "website_domain": e["GETPAY_WEBSITE_DOMAIN"],
                         "business_name": e.get("GETPAY_BUSINESS_NAME", ""), "image_url": e.get("GETPAY_IMAGE_URL", ""),
                         "currency": e.get("GETPAY_CURRENCY"), "bundle_url": e.get("GETPAY_BUNDLE_URL"),
                         "base_url": e.get("GETPAY_BASE_URL")}
    return cfg
