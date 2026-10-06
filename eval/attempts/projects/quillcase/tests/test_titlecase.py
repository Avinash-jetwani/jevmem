import unittest

from quillcase import title_case

GOLDEN = [
    ("a tale of two harbours", "A Tale of Two Harbours"),
    ("don't look back in the rain", "Don't Look Back in the Rain"),
    ("the cat's pyjamas and other stories", "The Cat's Pyjamas and Other Stories"),
    ("notes on the eBook for macOS", "Notes on the eBook for macOS"),
    ("the rise of NASA: a short history", "The Rise of NASA: A Short History"),
    ("a well-known shortcut to nowhere", "A Well-Known Shortcut to Nowhere"),
    ("what the tide brings in", "What the Tide Brings In"),
    ("north vs south (again)", "North vs South (Again)"),
    ("  loose   spacing is  tidied ", "Loose Spacing Is Tidied"),
]


class TitleCaseTest(unittest.TestCase):
    def test_golden(self):
        for text, expected in GOLDEN:
            with self.subTest(text=text):
                self.assertEqual(title_case(text), expected)

    def test_empty(self):
        self.assertEqual(title_case(""), "")


if __name__ == "__main__":
    unittest.main()
