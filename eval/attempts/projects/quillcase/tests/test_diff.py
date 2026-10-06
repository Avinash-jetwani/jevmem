import unittest

from quillcase import diff_lines, format_ops, hunks, stats

OLD_CONFIG = [
    "[server]",
    "host = localhost",
    "port = 8080",
    "workers = 4",
    "[cache]",
    "size = 64",
    "ttl = 300",
]

NEW_CONFIG = [
    "[cache]",
    "size = 64",
    "ttl = 300",
    "[server]",
    "host = localhost",
    "debug = true",
    "port = 8080",
    "log = stderr",
    "workers = 4",
]

GOLDEN = [
    (["alpha", "beta", "gamma"], ["alpha", "BETA", "gamma"], ["  alpha", "- beta", "+ BETA", "  gamma"]),
    (["one", "three"], ["one", "two", "three"], ["  one", "+ two", "  three"]),
    (["one", "two", "three"], ["one", "three"], ["  one", "- two", "  three"]),
    ([], ["x", "y"], ["+ x", "+ y"]),
    (["x", "y"], [], ["- x", "- y"]),
    (["a", "b"], ["a", "b"], ["  a", "  b"]),
    (["x", "a", "x"], ["x"], ["- x", "- a", "  x"]),
]


class DiffLinesTest(unittest.TestCase):
    def test_golden(self):
        for a, b, expected in GOLDEN:
            with self.subTest(a=a, b=b):
                self.assertEqual(format_ops(diff_lines(a, b)), expected)

    def test_reordered_sections(self):
        self.assertEqual(
            format_ops(diff_lines(OLD_CONFIG, NEW_CONFIG)),
            [
                "+ [cache]",
                "+ size = 64",
                "+ ttl = 300",
                "  [server]",
                "  host = localhost",
                "+ debug = true",
                "  port = 8080",
                "+ log = stderr",
                "  workers = 4",
                "- [cache]",
                "- size = 64",
                "- ttl = 300",
            ],
        )

    def test_ops_rebuild_both_sides(self):
        ops = diff_lines(OLD_CONFIG, NEW_CONFIG)
        self.assertEqual([line for tag, line in ops if tag != "+"], OLD_CONFIG)
        self.assertEqual([line for tag, line in ops if tag != "-"], NEW_CONFIG)


class StatsTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(stats(diff_lines(OLD_CONFIG, NEW_CONFIG)), (4, 3, 5))
        self.assertEqual(stats([]), (0, 0, 0))

    def test_unknown_tag(self):
        with self.assertRaises(ValueError):
            stats([("?", "line")])


class HunksTest(unittest.TestCase):
    def setUp(self):
        old = ["line %d" % n for n in range(1, 21)]
        new = list(old)
        new[2] = "line three"
        new[4] = "line five"
        new[15] = "line sixteen"
        self.ops = diff_lines(old, new)

    def test_hunks(self):
        self.assertEqual(hunks(self.ops, context=1), [(1, 8), (16, 20)])
        self.assertEqual(hunks(self.ops, context=6), [(0, 23)])
        self.assertEqual(hunks(diff_lines(["a"], ["a"])), [])

    def test_format_with_context(self):
        self.assertEqual(
            format_ops(self.ops, context=1),
            [
                "  line 2",
                "- line 3",
                "+ line three",
                "  line 4",
                "- line 5",
                "+ line five",
                "  line 6",
                "...",
                "  line 15",
                "- line 16",
                "+ line sixteen",
                "  line 17",
            ],
        )


if __name__ == "__main__":
    unittest.main()
