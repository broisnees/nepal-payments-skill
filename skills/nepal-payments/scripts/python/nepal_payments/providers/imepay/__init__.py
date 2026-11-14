"""IME Pay web checkout. See README.md in this folder."""

from .adapter import ImePay
from .endpoints import BASE

__all__ = ["BASE", "ImePay"]
