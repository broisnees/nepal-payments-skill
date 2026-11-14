"""Shared test fixtures. Tests run from scripts/python: python3 -m unittest discover -s tests -v"""

from __future__ import annotations

import base64
import json
import unittest
from typing import Any

from nepal_payments.core import HttpResponse


def resp(data: Any, status: int = 200) -> HttpResponse:
    """A mocked HTTP answer: `data` is the parsed body; a str is the raw text."""
    return HttpResponse(status, data, json.dumps(data) if not isinstance(data, str) else data)


def b64json(d: Any) -> str:
    return base64.b64encode(json.dumps(d).encode()).decode()


def new_rsa_key(test: unittest.TestCase) -> tuple[Any, bytes]:
    """(private key, PKCS#8 PEM) for RSA providers; skips the test when `cryptography` is missing."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        test.skipTest("pip install cryptography")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return key, pem
