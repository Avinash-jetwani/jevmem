import unittest

from quillcase import display_width, wrap

WIDTHS = [
    ("", 0),
    ("abc", 3),
    ("日本語", 6),
    ("ＡＢＣ", 6),
    ("한글", 4),
    ("🙂", 2),
    ("café", 4),
    ("ｶﾅ", 2),
]

GOLDEN = [
    (
        "The quick brown fox jumps over the lazy dog near the riverbank.",
        20,
        ["The quick brown fox", "jumps over the lazy", "dog near the", "riverbank."],
    ),
    (
        "日本語のテキストは単語の間に空白を入れません。",
        16,
        ["日本語のテキスト", "は単語の間に空白", "を入れません。"],
    ),
    (
        "Tokyo 東京 is written 東京都 in full, and Kyoto 京都 is not.",
        14,
        ["Tokyo 東京 is", "written 東京都", "in full, and", "Kyoto 京都 is", "not."],
    ),
    (
        "한국어 문장도 폭이 넓은 글자로 줄을 바꿉니다",
        12,
        ["한국어 문장", "도 폭이 넓은", "글자로 줄을", "바꿉니다"],
    ),
    (
        "Fullwidth ＡＢＣ and a smile 🙂 take two columns each.",
        16,
        ["Fullwidth ＡＢＣ", "and a smile 🙂", "take two columns", "each."],
    ),
    (
        "A pneumonoultramicroscopic word is cut.",
        12,
        ["A pneumonoul", "tramicroscop", "ic word is", "cut."],
    ),
    (
        "First paragraph here.\n\nSecond one.",
        12,
        ["First", "paragraph", "here.", "", "Second one."],
    ),
]


class DisplayWidthTest(unittest.TestCase):
    def test_widths(self):
        for text, expected in WIDTHS:
            with self.subTest(text=text):
                self.assertEqual(display_width(text), expected)


class WrapTest(unittest.TestCase):
    def test_golden(self):
        for text, width, expected in GOLDEN:
            with self.subTest(text=text, width=width):
                self.assertEqual(wrap(text, width), expected)

    def test_lines_fit(self):
        for text, width, _ in GOLDEN:
            for line in wrap(text, width):
                self.assertLessEqual(display_width(line), width)

    def test_default_width(self):
        text = "word " * 40
        self.assertEqual([len(line) for line in wrap(text)], [79, 79, 39])

    def test_narrow_width_is_rejected(self):
        with self.assertRaises(ValueError):
            wrap("text", 1)


if __name__ == "__main__":
    unittest.main()
