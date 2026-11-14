import unittest

from nepal_payments import render_auto_submit_form
from nepal_payments.core import FormResult


class HtmlTests(unittest.TestCase):
    def test_form_escape(self):
        form = FormResult("https://x", {"a": '"><script>'}, enctype="multipart/form-data")
        html = render_auto_submit_form(form)
        self.assertIn("&quot;&gt;&lt;script&gt;", html)
        self.assertIn('enctype="multipart/form-data"', html)


if __name__ == "__main__":
    unittest.main()
