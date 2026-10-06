import unittest

from quillcase import slugify

ASCII = [
    ("Hello, World!", "hello-world"),
    ("  Spaces   and\ttabs  ", "spaces-and-tabs"),
    ("snake_case_name", "snake-case-name"),
    ("Version 2.0 (beta)", "version-2-0-beta"),
    ("Don't Stop", "dont-stop"),
    ("It’s a Wrap", "its-a-wrap"),
    ("Rock & Roll", "rock-and-roll"),
]

LATIN = [
    ("Crème Brûlée à la carte", "creme-brulee-a-la-carte"),
    ("Smørrebrød på Østerbro", "smorrebrod-pa-osterbro"),
    ("Straße & Fußgänger", "strasse-and-fussganger"),
    ("Łódź, Kraków", "lodz-krakow"),
    ("Œuvres complètes", "oeuvres-completes"),
    ("café society", "cafe-society"),
]

OTHER_SCRIPTS = [
    ("Ελληνικός καφές", "ελληνικός-καφές"),
    ("ΟΔΟΣ ΑΘΗΝΑΣ", "οδος-αθηνας"),
    ("Чай и йогурт", "чай-и-йогурт"),
    ("東京ガイド 2024", "東京ガイド-2024"),
    ("がっこうの ともだち", "がっこうの-ともだち"),
    ("한글 맞춤법", "한글-맞춤법"),
]


class SlugifyTest(unittest.TestCase):
    def check(self, cases):
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(slugify(text), expected)

    def test_ascii(self):
        self.check(ASCII)

    def test_latin(self):
        self.check(LATIN)

    def test_other_scripts(self):
        self.check(OTHER_SCRIPTS)

    def test_empty(self):
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify(" -- "), "")


if __name__ == "__main__":
    unittest.main()
