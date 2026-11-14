"""connectIPS (NCHL) e-payment gateway. See README.md in this folder."""

from .adapter import ConnectIps
from .endpoints import BASE
from .signing import connectips_date, connectips_token_string

__all__ = ["BASE", "ConnectIps", "connectips_date", "connectips_token_string"]
