"""One package per gateway. Each exposes its adapter class and a `config.from_env()` reader.

To add a gateway, see scripts/python/CONTRIBUTING.md.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

from .connectips import ConnectIps
from .connectips import config as connectips_config
from .cybersource import CyberSource
from .cybersource import config as cybersource_config
from .esewa import Esewa
from .esewa import config as esewa_config
from .fonepay import Fonepay
from .fonepay import config as fonepay_config
from .getpay import GetPay
from .getpay import config as getpay_config
from .hamropay import HamroPay
from .hamropay import config as hamropay_config
from .imepay import ImePay
from .imepay import config as imepay_config
from .khalti import Khalti
from .khalti import config as khalti_config
from .nepalpay import NepalPay
from .nepalpay import config as nepalpay_config
from .nps import Nps
from .nps import config as nps_config

EnvReader = Callable[[Mapping[str, str]], Optional[dict[str, Any]]]

# Provider id -> adapter class. The order is the order config_from_env() returns providers in.
PROVIDER_CLASSES: dict[str, type] = {
    "esewa": Esewa,
    "khalti": Khalti,
    "fonepay": Fonepay,
    "connectips": ConnectIps,
    "cybersource": CyberSource,
    "nps": Nps,
    "imepay": ImePay,
    "nepalpay": NepalPay,
    "hamropay": HamroPay,
    "getpay": GetPay,
}

# Provider id -> reader that turns environment variables into constructor kwargs (or None).
ENV_READERS: dict[str, EnvReader] = {
    "esewa": esewa_config.from_env,
    "khalti": khalti_config.from_env,
    "fonepay": fonepay_config.from_env,
    "connectips": connectips_config.from_env,
    "cybersource": cybersource_config.from_env,
    "nps": nps_config.from_env,
    "imepay": imepay_config.from_env,
    "nepalpay": nepalpay_config.from_env,
    "hamropay": hamropay_config.from_env,
    "getpay": getpay_config.from_env,
}

__all__ = [
    "ENV_READERS",
    "PROVIDER_CLASSES",
    "ConnectIps",
    "CyberSource",
    "Esewa",
    "Fonepay",
    "GetPay",
    "HamroPay",
    "ImePay",
    "Khalti",
    "NepalPay",
    "Nps",
]
