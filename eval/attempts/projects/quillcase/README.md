# quillcase

A small text toolkit in plain Python: standard library only, nothing to install.

- `slugify(text, max_length=60)`: lower-case, hyphen-separated slugs; Latin accents are folded, other scripts are kept.
- `wrap(text, width=80)`: word-wrap by display width; CJK, fullwidth forms and emoji take two columns.
- `diff_lines(a, b)`: line diff from a longest-common-subsequence table, with `format_ops`, `hunks` and `stats`.
- `title_case(text)`: headline capitalisation that keeps small words lower-case.

## Tests

Run `python3 -m unittest` in this directory. Every module has golden cases under `tests/`.

## Benchmark

Run `python3 bench.py`. It prints one timing per function.
