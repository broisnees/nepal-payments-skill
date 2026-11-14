"""HTTP with timeouts (urllib). Retries only for idempotent reads (status checks)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.client import HTTPException, IncompleteRead
from typing import Any, Mapping, Optional, Union

from .encoding import b64encode
from .errors import PaymentError

# A request body: str/bytes are sent as-is (exact bytes that were signed), anything else as JSON.
RequestBody = Union[str, bytes, dict, list, None]

_DEFAULT_HEADERS = {"Accept": "application/json", "User-Agent": "nepal-payments/1.0"}


@dataclass
class HttpResponse:
    status: int
    data: Any  # parsed JSON, or the raw text when the body is not JSON, or None when empty
    text: str
    headers: Mapping[str, str] = field(default_factory=dict)

    def json_object(self) -> Optional[dict[str, Any]]:
        """The parsed body when it is a JSON object, else None."""
        return self.data if isinstance(self.data, dict) else None


def basic_auth(user: str, password: str) -> str:
    """HTTP Basic credentials (UTF-8) for an Authorization header."""
    return "Basic " + b64encode(f"{user}:{password}".encode())


def http(
    provider: str,
    url: str,
    method: str = "GET",
    headers: Optional[Mapping[str, str]] = None,
    body: RequestBody = None,
    timeout: float = 15.0,
    retries: int = 0,
) -> HttpResponse:
    """Send one request; 4xx/5xx answers are returned, not raised.

    Network failures (and 5xx/429 while retries remain) are retried with backoff
    0.3s, 0.6s, ...; when every attempt fails, PaymentError("network_error") is raised.
    """
    request_headers = {**_DEFAULT_HEADERS, **(headers or {})}
    data = _encode_body(body, request_headers)

    last_error: Optional[BaseException] = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(0.3 * 2 ** (attempt - 1))
        request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
        try:
            status, text, response_headers = _send(request, timeout)
        except (urllib.error.URLError, TimeoutError, OSError, HTTPException) as e:
            last_error = e
            continue
        if (status >= 500 or status == 429) and attempt < retries:
            last_error = PaymentError(f"HTTP {status}", provider, "upstream_error", status, text)
            continue
        return HttpResponse(status, _parse_json(text), text, response_headers)

    raise PaymentError(
        f"request to {url} failed: {last_error}", provider, "network_error", details=last_error
    )


def _encode_body(body: RequestBody, headers: dict[str, str]) -> Optional[bytes]:
    """Body bytes; also sets a JSON Content-Type unless the caller chose one."""
    if body is None:
        return None
    if isinstance(body, str):
        data = body.encode()
    elif isinstance(body, bytes):
        data = body
    else:
        data = json.dumps(body).encode()
    if not any(name.lower() == "content-type" for name in headers):
        headers["Content-Type"] = "application/json"
    return data


def _send(request: urllib.request.Request, timeout: float) -> tuple[int, str, dict[str, str]]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return res.status, _read_text(res), dict(res.headers)
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry a body we want
        return e.code, _read_text(e), dict(e.headers or {})


def _read_text(res: Any) -> str:
    """Read the body as text.

    A body cut off mid-stream is kept only when what arrived is complete JSON:
    Hamro Pay (grpc-gateway behind Envoy) aborts the chunked stream after its error answers.
    """
    try:
        raw = res.read()
    except IncompleteRead as e:
        raw = e.partial
        try:
            json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            raise e from None
    return raw.decode("utf-8", "replace")


def _parse_json(text: str) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text
