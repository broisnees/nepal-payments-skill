import re
import socket
import threading
import unittest
from unittest import mock

from nepal_payments import HamroPay, PaymentError


class TruncatedBody(unittest.TestCase):
    """Hamro Pay's Envoy front aborts the chunked stream after an error answer: no terminating 0-length chunk."""

    @staticmethod
    def serve(chunk: bytes, status: str = "401 Unauthorized"):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(8)

        def loop():
            while True:
                try:
                    conn, _ = srv.accept()
                except OSError:
                    return
                with conn:
                    buf = b""
                    while b"\r\n\r\n" not in buf:
                        part = conn.recv(65536)
                        if not part:
                            break
                        buf += part
                    head, _, rest = buf.partition(b"\r\n\r\n")
                    m = re.search(rb"(?i)content-length:\s*(\d+)", head)
                    need = int(m.group(1)) if m else 0
                    while len(rest) < need:
                        part = conn.recv(65536)
                        if not part:
                            break
                        rest += part
                    head = (
                        f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n"
                        f"Transfer-Encoding: chunked\r\n\r\n{len(chunk):x}\r\n"
                    )
                    conn.sendall(head.encode() + chunk + b"\r\n")

        threading.Thread(target=loop, daemon=True).start()
        return srv, f"http://127.0.0.1:{srv.getsockname()[1]}"

    def hamro(self, base):
        return HamroPay("sandbox", "m", "c", "k", "s", api_base_url=base, timeout=5)

    def test_complete_json_is_kept(self):
        srv, base = self.serve(b'{"code":16,"message":"Unauthorized Request","details":[]}')
        try:
            with self.assertRaises(PaymentError) as cm:
                self.hamro(base).verify("O1", 1000)
        finally:
            srv.close()
        self.assertEqual((cm.exception.code, cm.exception.http_status), ("unauthorized", 401))
        self.assertEqual(cm.exception.details["message"], "Unauthorized Request")

    def test_truncated_invalid_json_is_network_error(self):
        srv, base = self.serve(b'{"code":16,"message":"Unauth')
        try:
            # Skip the retry backoff in core/http.py.
            with mock.patch("time.sleep"), self.assertRaises(PaymentError) as cm:
                self.hamro(base).verify("O1", 1000)
        finally:
            srv.close()
        self.assertEqual(cm.exception.code, "network_error")


if __name__ == "__main__":
    unittest.main()
