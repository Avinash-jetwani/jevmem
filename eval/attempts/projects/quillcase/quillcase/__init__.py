"""quillcase: slugs, word-wrap, line diffs and title case."""
from .diff import diff_lines, format_ops, hunks, stats
from .slug import slugify
from .titlecase import title_case
from .wrap import display_width, wrap

__all__ = [
    "diff_lines",
    "display_width",
    "format_ops",
    "hunks",
    "slugify",
    "stats",
    "title_case",
    "wrap",
]
