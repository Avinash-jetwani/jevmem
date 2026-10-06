"""Pages: front matter, slugs and the Page record."""

import re
from dataclasses import dataclass, field
from typing import List

from .markdown import to_html


@dataclass
class Page:
    slug: str
    title: str
    body: str
    date: str = ""
    tags: List[str] = field(default_factory=list)
    draft: bool = False


def split_front_matter(text):
    """Split a source file into (meta, body).

    Front matter is a block of `key: value` lines between two `---` lines at
    the very top of the file. A file without it has empty meta.
    """
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text
    meta = {}
    for number, line in enumerate(lines[1:], start=2):
        if line.strip() == "---":
            return meta, "\n".join(lines[number:])
        if not line.strip():
            continue
        key, colon, value = line.partition(":")
        if not colon or not key.strip():
            raise ValueError(f"front matter line {number}: expected 'key: value'")
        meta[key.strip().lower()] = value.strip()
    raise ValueError("front matter is not closed with '---'")


def slugify(name):
    slug = re.sub(r"[^a-z0-9_]+", "-", name.lower()).strip("-")
    return slug or "page"


def title_from_slug(slug):
    words = slug.replace("_", "-").split("-")
    return " ".join(word[:1].upper() + word[1:] for word in words if word)


def make_page(filename, text):
    """Build a Page from a content file's name and its text."""
    meta, body = split_front_matter(text)
    stem = filename[:-3] if filename.endswith(".md") else filename
    slug = slugify(meta.get("slug") or stem)
    tags = [tag.strip() for tag in meta.get("tags", "").split(",") if tag.strip()]
    return Page(
        slug=slug,
        title=meta.get("title") or title_from_slug(slug),
        body=to_html(body),
        date=meta.get("date", ""),
        tags=tags,
        draft=bool(meta.get("draft")),
    )
