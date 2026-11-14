"""Base64 and text renderings that every port must produce byte-for-byte."""

from __future__ import annotations

import base64
import json
from typing import Any


def b64encode(data: bytes) -> str:
    """Standard base64 with padding, as str."""
    return base64.b64encode(data).decode("ascii")


def b64decode_lenient(text: str) -> bytes:
    """Tolerates url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers."""
    # Spaces first, or a "+" at either edge is lost by strip().
    text = text.replace(" ", "+").strip()
    text = text.replace("-", "+").replace("_", "/")
    text += "=" * (-len(text) % 4)
    return base64.b64decode(text)


def base64_json(text: str) -> Any:
    """Decode base64 (leniently) and parse the JSON inside."""
    return json.loads(b64decode_lenient(text).decode("utf-8"))


def js_string(value: Any) -> str:
    """A JSON value formatted like JavaScript String(v), so every port signs the same text.

    None -> "", True -> "true", 100.0 -> "100", 1.5 -> "1.5".
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return str(value)
