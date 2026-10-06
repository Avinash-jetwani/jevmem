"""Build a site: read the content, render every page, write the output."""

import os
import re

from .markdown import escape
from .pages import make_page, title_from_slug

DEFAULT_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ title }} - {{ site.title }}</title>
</head>
<body>
<nav>{{ nav }}</nav>
<main>
<h1>{{ title }}</h1>
{{ content }}
</main>
<footer>{{ date }} {{ tags }}</footer>
</body>
</html>
"""

_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_.]+)\s*\}\}")


class BuildError(Exception):
    """The content cannot be turned into a site as it stands."""


def apply_template(template, context):
    """Fill `{{ name }}` and `{{ outer.inner }}` placeholders from `context`."""

    def lookup(match):
        value = context
        for part in match.group(1).split("."):
            if not isinstance(value, dict) or part not in value:
                raise BuildError(f"template uses unknown name {match.group(1)!r}")
            value = value[part]
        return str(value)

    return _PLACEHOLDER.sub(lookup, template)


def read_template(config):
    if config.template is None:
        return DEFAULT_TEMPLATE
    with open(os.path.join(config.root, config.template), encoding="utf-8") as handle:
        return handle.read()


def load_pages(config):
    """Read every .md file in the content directory, drafts left out."""
    content_dir = os.path.join(config.root, config.content_dir)
    pages = []
    sources = {}
    for name in sorted(os.listdir(content_dir)):
        if not name.endswith(".md"):
            continue
        with open(os.path.join(content_dir, name), encoding="utf-8") as handle:
            try:
                page = make_page(name, handle.read())
            except ValueError as exc:
                raise BuildError(f"{name}: {exc}")
        if page.draft:
            continue
        if page.slug in sources:
            raise BuildError(f"{name} and {sources[page.slug]} both use the slug {page.slug!r}")
        if page.slug == "index":
            raise BuildError(f"{name}: the slug 'index' is taken by the index page")
        sources[page.slug] = name
        pages.append(page)
    return pages


def page_url(config, slug):
    return config.base_url.rstrip("/") + "/" + slug + "/"


def nav_html(config):
    links = [f'<a href="{escape(config.base_url)}">Home</a>']
    for slug in config.nav:
        links.append(f'<a href="{escape(page_url(config, slug))}">{escape(title_from_slug(slug))}</a>')
    return " ".join(links)


def page_context(page, shared):
    context = dict(shared)
    context.update(
        {
            "title": escape(page.title),
            "content": page.body,
            "date": escape(page.date),
            "tags": escape(", ".join(page.tags)),
        }
    )
    return context


def index_html(config, pages):
    """The list of pages for the front page, ordered by slug."""
    listed = sorted(pages, key=lambda page: page.slug)
    if config.index_limit is not None:
        listed = listed[: config.index_limit]
    rows = []
    for page in listed:
        row = f'<li><a href="{escape(page_url(config, page.slug))}">{escape(page.title)}</a>'
        if page.date:
            row += f" <time>{escape(page.date)}</time>"
        rows.append(row + "</li>")
    return "<ul>\n" + "\n".join(rows) + "\n</ul>"


def write_file(path, html):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(html)


def build_site(config):
    """Render the whole site into the output directory and return its pages."""
    template = read_template(config)
    output_dir = os.path.join(config.root, config.output_dir)
    shared = {
        "site": {"title": escape(config.title), "base_url": escape(config.base_url)},
        "nav": nav_html(config),
    }

    pages = load_pages(config)
    for page in pages:
        html = apply_template(template, page_context(page, shared))
        write_file(os.path.join(output_dir, page.slug, "index.html"), html)

    front = dict(shared)
    front.update(
        {"title": escape(config.title), "content": index_html(config, pages), "date": "", "tags": ""}
    )
    write_file(os.path.join(output_dir, "index.html"), apply_template(template, front))
    return pages
