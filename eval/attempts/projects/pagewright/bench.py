"""Timings for the hot paths: python3 bench.py [number of pages]"""

import os
import sys
import tempfile
import time
import timeit

from pagewright.build import build_site
from pagewright.config import Config
from pagewright.markdown import escape

PARAGRAPH = (
    "The ferry leaves at 7 & returns before dark; bring a coat if the wind is < 10 knots "
    'and the sky looks "settled". Notes from the *last* crossing are in `log.txt`, and '
    "the [timetable](/timetable/) has the winter hours.\n"
)

PAGE = """---
title: Crossing number {number}
date: 2024-{month:02d}-{day:02d}
tags: ferry, log
---
## Weather

{paragraph}
- wind from the west
- **two** metre swell
- visibility > 5 miles

> Check the moorings before you leave.

```
knots = distance / hours
```

{paragraph}
"""


def make_site(root, count):
    content = os.path.join(root, "content")
    os.mkdir(content)
    for number in range(count):
        text = PAGE.format(
            number=number, month=number % 12 + 1, day=number % 28 + 1, paragraph=PARAGRAPH
        )
        with open(os.path.join(content, f"crossing-{number:04d}.md"), "w", encoding="utf-8") as handle:
            handle.write(text)


def bench_escape(repeat=5, number=20000):
    """Best time for one escape() call on a paragraph, in microseconds."""
    text = PARAGRAPH * 3
    best = min(timeit.repeat(lambda: escape(text), repeat=repeat, number=number))
    return best / number * 1e6


def bench_build(count, repeat=5):
    """Best time for one full build of `count` pages, in milliseconds."""
    with tempfile.TemporaryDirectory() as root:
        make_site(root, count)
        config = Config(title="Ferry log", root=root, index_limit=20)
        timings = []
        for _ in range(repeat):
            start = time.perf_counter()
            build_site(config)
            timings.append(time.perf_counter() - start)
    return min(timings) * 1e3


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    print(f"escape: {bench_escape():.2f} us per call")
    print(f"build:  {bench_build(count):.1f} ms for {count} pages (best of 5)")


if __name__ == "__main__":
    main()
