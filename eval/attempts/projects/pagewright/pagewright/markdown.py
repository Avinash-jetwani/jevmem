"""A small Markdown subset: headings, paragraphs, lists, quotes, fenced code."""

import re


def escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def render_inline(text):
    """Escape `text`, then apply code spans, bold, italics and links."""
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', text)
    return text


def classify(line):
    """Name the kind of block a source line belongs to."""
    if line.startswith("```"):
        return "fence"
    if not line.strip():
        return "blank"
    if re.match(r"#{1,6} ", line):
        return "heading"
    if line.startswith("- "):
        return "item"
    if line.startswith("> "):
        return "quote"
    return "text"


def _strip_marker(line, marker):
    if line.startswith(marker):
        return line[len(marker):]
    return line


def to_html(source):
    """Render Markdown source to an HTML fragment."""
    out = []
    paragraph, items, quote = [], [], []
    code = None

    def flush():
        if paragraph:
            out.append("<p>" + render_inline(" ".join(paragraph)) + "</p>")
            paragraph.clear()
        if items:
            rows = "".join("<li>" + render_inline(item) + "</li>" for item in items)
            out.append("<ul>" + rows + "</ul>")
            items.clear()
        if quote:
            out.append("<blockquote><p>" + render_inline(" ".join(quote)) + "</p></blockquote>")
            quote.clear()

    for line in source.split("\n"):
        if code is not None:
            if line.startswith("```"):
                out.append("<pre><code>" + escape("\n".join(code)) + "</code></pre>")
                code = None
            else:
                code.append(line)
            continue

        kind = classify(line)
        if kind == "fence":
            flush()
            code = []
        elif kind == "heading":
            flush()
            level = len(line) - len(line.lstrip("#"))
            out.append(f"<h{level}>{render_inline(line[level:].strip())}</h{level}>")
        elif kind == "item":
            if paragraph or quote:
                flush()
            items.append(_strip_marker(line, "- ").strip())
        elif kind == "quote":
            if paragraph or items:
                flush()
            quote.append(_strip_marker(line, "> ").strip())
        elif kind == "blank":
            flush()
        else:
            if items or quote:
                flush()
            paragraph.append(line.strip())

    if code is not None:
        out.append("<pre><code>" + escape("\n".join(code)) + "</code></pre>")
    flush()
    return "\n".join(out)
