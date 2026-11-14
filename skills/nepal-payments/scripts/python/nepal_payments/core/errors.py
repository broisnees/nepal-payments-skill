"""The one exception type adapters raise, and the shared builder for failed HTTP answers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from .http import HttpResponse


class PaymentError(Exception):
    """A provider call failed or a callback could not be trusted.

    `code` is stable and machine-readable (e.g. "invalid_signature", "http_502", "esewa_IP-400");
    `details` carries the provider body or the offending payload for logging.
    """

    def __init__(
        self,
        message: str,
        provider: str,
        code: str,
        http_status: Optional[int] = None,
        details: Any = None,
    ):
        super().__init__(message)
        self.provider = provider
        self.code = code
        self.http_status = http_status
        self.details = details


def http_error(
    provider: str,
    res: HttpResponse,
    summary: str,
    *,
    detail: Optional[str] = None,
    code: Optional[str] = None,
    text_limit: int = 200,
) -> PaymentError:
    """PaymentError for an HTTP answer that is not a usable success.

    The message reads "<summary>: <detail>", where `detail` defaults to the start of the response
    body. `code` defaults to "http_<status>". The parsed body goes into `details`.
    """
    if detail is None:
        detail = res.text[:text_limit]
    return PaymentError(
        f"{summary}: {detail}",
        provider,
        code or f"http_{res.status}",
        res.status,
        res.data,
    )
