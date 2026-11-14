import unittest

from nepal_payments import new_order_id


class PublicApiTests(unittest.TestCase):
    def test_order_id(self):
        for _ in range(500):
            o = new_order_id()
            self.assertTrue(17 <= len(o) <= 20 and o.isalnum())


if __name__ == "__main__":
    unittest.main()
