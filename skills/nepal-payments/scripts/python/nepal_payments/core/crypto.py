"""HMAC (stdlib) and RSA (needs `cryptography`, only for connectIPS and NEPALPAY QR).

`cryptography` is imported inside each RSA function so the stdlib-only providers never need it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import TYPE_CHECKING, Literal, Optional, Union

from .encoding import b64encode

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

_INSTALL_HINT = "pip install cryptography  (needed for RSA-signed providers)"


def hmac_digest(
    algo: Literal["sha256", "sha512"],
    key: Union[str, bytes],
    message: Union[str, bytes],
) -> bytes:
    """Raw HMAC digest. str inputs are UTF-8 encoded."""
    key_bytes = key.encode() if isinstance(key, str) else key
    message_bytes = message.encode() if isinstance(message, str) else message
    return hmac.new(key_bytes, message_bytes, getattr(hashlib, algo)).digest()


def safe_equal(a: str, b: str) -> bool:
    """Constant-time string comparison for signatures."""
    return hmac.compare_digest(a.encode(), b.encode())


def rsa_sha256_sign_b64(
    private_key_pem: bytes, message: str, password: Optional[bytes] = None
) -> str:
    """RSA PKCS#1 v1.5 + SHA-256, base64. Accepts PEM (PKCS#1 or PKCS#8)."""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(_INSTALL_HINT) from e
    key = serialization.load_pem_private_key(private_key_pem, password=password)
    signature = key.sign(message.encode(), padding.PKCS1v15(), hashes.SHA256())  # type: ignore[union-attr,call-arg]
    return b64encode(signature)


def _load_spki(public_key_pem: Union[str, bytes]) -> RSAPublicKey:
    """Load an SPKI "-----BEGIN PUBLIC KEY-----".

    From a certificate (.cer/.crt):
        openssl x509 -in NPI.cer [-inform der] -pubkey -noout > npi.pub.pem
    """
    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(_INSTALL_HINT) from e
    pem = public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem
    if b"BEGIN PUBLIC KEY" not in pem:
        raise ValueError(
            "expected a PUBLIC KEY PEM; extract it from the certificate with: "
            "openssl x509 -in NPI.cer -pubkey -noout"
        )
    return serialization.load_pem_public_key(pem)  # type: ignore[return-value]


def rsa_sha256_verify_b64(
    public_key_pem: Union[str, bytes], message: str, signature_b64: str
) -> bool:
    """Verify an RSA PKCS#1 v1.5 + SHA-256 signature (base64). False on any malformed input."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        key = _load_spki(public_key_pem)
        signature = base64.b64decode(signature_b64, validate=True)
        key.verify(signature, message.encode(), padding.PKCS1v15(), hashes.SHA256())
        return True
    except Exception:
        return False


def rsa_pkcs1_encrypt_b64(public_key_pem: Union[str, bytes], plaintext: str) -> str:
    """RSA PKCS#1 v1.5 encryption ("RSA/ECB/PKCS1Padding"), base64 output."""
    from cryptography.hazmat.primitives.asymmetric import padding

    key = _load_spki(public_key_pem)
    message = plaintext.encode()
    key_bytes = (key.key_size + 7) // 8
    max_bytes = key_bytes - 11  # PKCS#1 v1.5 padding needs 11 bytes
    if len(message) > max_bytes:
        raise ValueError(
            f"plaintext too long for a {key_bytes * 8}-bit RSA key (max {max_bytes} bytes)"
        )
    return b64encode(key.encrypt(message, padding.PKCS1v15()))


def load_pfx_private_key_pem(pfx_bytes: bytes, password: str) -> bytes:
    """Extract the private key from a .pfx/.p12 (e.g. connectIPS CREDITOR.pfx) as PKCS#8 PEM."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import pkcs12

    key, _cert, _chain = pkcs12.load_key_and_certificates(pfx_bytes, password.encode())
    if key is None:
        raise ValueError("no private key in pfx")
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
