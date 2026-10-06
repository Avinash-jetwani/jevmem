"""Print one timing per function: python3 bench.py"""
import time

from quillcase import diff_lines, slugify, title_case, wrap

TITLES = (
    "Crème brûlée à la carte",
    "Smørrebrød på Østerbro",
    "Straße & Fußgänger: ein Überblick",
    "Łódź, Kraków and the long way home",
    "Notes from a very quiet winter",
    "What the tide brings in (and takes out)",
    "東京ガイド for first-time visitors",
    "Ελληνικός καφές, twice a day",
)

PARAGRAPH = (
    "The harbour office keeps two ledgers, one for the boats that leave and one "
    "for the boats that come back. 港の事務所には帳簿が二冊あり、出る船と戻る船を"
    "別々に記録しています。 Nobody remembers who started the second one."
)


def best_of(fn, rounds=5):
    """Return the fastest of rounds timings of fn(), in seconds."""
    best = None
    for _ in range(rounds):
        start = time.perf_counter()
        fn()
        took = time.perf_counter() - start
        if best is None or took < best:
            best = took
    return best


def main():
    titles = ["%s, part %d" % (TITLES[n % len(TITLES)], n) for n in range(4000)]
    text = "\n".join([PARAGRAPH] * 150)
    old = ["line %d of the report" % n for n in range(300)]
    new = [line for n, line in enumerate(old) if n % 7]
    for n in range(0, len(new), 11):
        new.insert(n, "inserted before row %d" % n)

    took = best_of(lambda: [slugify(title) for title in titles])
    print("slugify     %5d titles       %.4f s" % (len(titles), took))
    took = best_of(lambda: [title_case(title) for title in titles])
    print("title_case  %5d titles       %.4f s" % (len(titles), took))
    took = best_of(lambda: wrap(text, 40))
    print("wrap        %5d characters   %.4f s" % (len(text), took))
    took = best_of(lambda: diff_lines(old, new))
    print("diff_lines  %d x %d lines    %.4f s" % (len(old), len(new), took))


if __name__ == "__main__":
    main()
