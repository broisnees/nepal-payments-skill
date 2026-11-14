import base64
import unittest

from nepal_payments.core import b64decode_lenient, basic_auth


class EncodingTests(unittest.TestCase):
    def test_b64_space_restore(self):
        self.assertEqual(b64decode_lenient(" /  "), bytes([251, 255, 190]))  # "+/++" after '+'->' '

    def test_basic_auth_utf8(self):
        self.assertEqual(
            basic_auth("ü", "पासवर्ड"),
            "Basic " + base64.b64encode("ü:पासवर्ड".encode()).decode(),
        )


if __name__ == "__main__":
    unittest.main()
