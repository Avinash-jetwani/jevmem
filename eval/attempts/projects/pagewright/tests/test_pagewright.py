import json
import os
import tempfile
import unittest

from pagewright.build import BuildError, apply_template, build_site, index_html
from pagewright.config import Config, ConfigError, load_config
from pagewright.markdown import escape, render_inline, to_html
from pagewright.pages import Page, make_page, slugify, split_front_matter, title_from_slug


class MarkdownTest(unittest.TestCase):
    def test_escape(self):
        self.assertEqual(escape('a < b & "c" > d'), "a &lt; b &amp; &quot;c&quot; &gt; d")

    def test_inline(self):
        self.assertEqual(
            render_inline("**bold**, *slanted* and `x < y`"),
            "<strong>bold</strong>, <em>slanted</em> and <code>x &lt; y</code>",
        )
        self.assertEqual(
            render_inline("see [the guide](/guide/)"), 'see <a href="/guide/">the guide</a>'
        )
        self.assertEqual(render_inline('the "long" way round'), "the &quot;long&quot; way round")

    def test_headings(self):
        self.assertEqual(to_html("# One\n\n### Three & more"), "<h1>One</h1>\n<h3>Three &amp; more</h3>")

    def test_paragraph_lines_are_joined(self):
        self.assertEqual(to_html("first line\nsecond line\n\nnext"), "<p>first line second line</p>\n<p>next</p>")

    def test_list(self):
        self.assertEqual(
            to_html("Shopping:\n- tea\n- *green* apples\n"),
            "<p>Shopping:</p>\n<ul><li>tea</li><li><em>green</em> apples</li></ul>",
        )

    def test_quote(self):
        self.assertEqual(
            to_html("> measure twice,\n> so you don't cut twice"),
            "<blockquote><p>measure twice, so you don't cut twice</p></blockquote>",
        )

    def test_fenced_code(self):
        source = "```\nif a < b:\n    **not bold**\n```\nafter"
        self.assertEqual(
            to_html(source), "<pre><code>if a &lt; b:\n    **not bold**</code></pre>\n<p>after</p>"
        )


class PagesTest(unittest.TestCase):
    def test_front_matter(self):
        meta, body = split_front_matter("---\nTitle: Hello\ntags: a, b\n---\nBody text\n")
        self.assertEqual(meta, {"title": "Hello", "tags": "a, b"})
        self.assertEqual(body, "Body text\n")

    def test_without_front_matter(self):
        self.assertEqual(split_front_matter("Just text"), ({}, "Just text"))

    def test_unclosed_front_matter(self):
        with self.assertRaises(ValueError):
            split_front_matter("---\ntitle: Hello\nBody")

    def test_slugify(self):
        self.assertEqual(slugify("Getting Started!"), "getting-started")
        self.assertEqual(slugify("  Tea & Cake  "), "tea-cake")
        self.assertEqual(slugify("???"), "page")

    def test_title_from_slug(self):
        self.assertEqual(title_from_slug("getting-started"), "Getting Started")
        self.assertEqual(title_from_slug("2nd-edition-notes"), "2nd Edition Notes")

    def test_make_page(self):
        page = make_page("field-notes.md", "---\ndate: 2024-03-09\ntags: birds, maps\n---\n# Hi\n")
        self.assertEqual(
            page,
            Page(
                slug="field-notes",
                title="Field Notes",
                body="<h1>Hi</h1>",
                date="2024-03-09",
                tags=["birds", "maps"],
            ),
        )

    def test_draft(self):
        self.assertTrue(make_page("wip.md", "---\ndraft: true\n---\nSoon.").draft)
        self.assertFalse(make_page("done.md", "Ready.").draft)


class ConfigTest(unittest.TestCase):
    def write(self, data):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        self.addCleanup(os.unlink, handle.name)
        with handle:
            handle.write(data if isinstance(data, str) else json.dumps(data))
        return handle.name

    def test_load(self):
        path = self.write({"title": "Notes", "nav": ["about"], "index_limit": 5, "template": None})
        config = load_config(path)
        self.assertEqual(config.title, "Notes")
        self.assertEqual(config.nav, ["about"])
        self.assertEqual(config.index_limit, 5)
        self.assertIsNone(config.template)
        self.assertEqual(config.output_dir, "public")
        self.assertEqual(config.root, os.path.dirname(os.path.abspath(path)))

    def test_unknown_setting(self):
        with self.assertRaisesRegex(ConfigError, "unknown setting 'titel'"):
            load_config(self.write({"titel": "Notes"}))

    def test_wrong_type(self):
        with self.assertRaisesRegex(ConfigError, "index_limit has to be int or null"):
            load_config(self.write({"index_limit": "five"}))
        with self.assertRaisesRegex(ConfigError, "nav has to be a list of str"):
            load_config(self.write({"nav": ["about", 3]}))

    def test_not_json(self):
        with self.assertRaisesRegex(ConfigError, "not valid JSON"):
            load_config(self.write("{title: Notes}"))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        os.mkdir(os.path.join(self.root, "content"))

    def add(self, name, text):
        with open(os.path.join(self.root, "content", name), "w", encoding="utf-8") as handle:
            handle.write(text)

    def read(self, *parts):
        with open(os.path.join(self.root, "public", *parts), encoding="utf-8") as handle:
            return handle.read()

    def config(self, **settings):
        return Config(root=self.root, **settings)

    def test_build(self):
        self.add("hello.md", "---\ntitle: Hello <World>\ndate: 2024-03-09\n---\nSome *text*.\n")
        self.add("about.md", "About this site.\n")
        self.add("notes.txt", "not a page")
        pages = build_site(self.config(title="Notes", nav=["about"]))

        self.assertEqual([page.slug for page in pages], ["about", "hello"])
        hello = self.read("hello", "index.html")
        self.assertIn("<title>Hello &lt;World&gt; - Notes</title>", hello)
        self.assertIn("<p>Some <em>text</em>.</p>", hello)
        self.assertIn('<nav><a href="/">Home</a> <a href="/about/">About</a></nav>', hello)
        index = self.read("index.html")
        self.assertIn('<li><a href="/about/">About</a></li>', index)
        self.assertIn('<li><a href="/hello/">Hello &lt;World&gt;</a> <time>2024-03-09</time></li>', index)
        self.assertFalse(os.path.exists(os.path.join(self.root, "public", "notes")))

    def test_drafts_are_left_out(self):
        self.add("wip.md", "---\ndraft: true\n---\nSoon.\n")
        self.add("ready.md", "Ready.\n")
        pages = build_site(self.config())
        self.assertEqual([page.slug for page in pages], ["ready"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "public", "wip")))

    def test_same_slug_twice(self):
        self.add("a.md", "---\nslug: guide\n---\nOne\n")
        self.add("b.md", "---\nslug: Guide\n---\nTwo\n")
        with self.assertRaisesRegex(BuildError, "b.md and a.md both use the slug 'guide'"):
            build_site(self.config())

    def test_custom_template(self):
        with open(os.path.join(self.root, "page.html"), "w", encoding="utf-8") as handle:
            handle.write("<h1>{{title}}</h1>{{ content }}<p>{{ site.base_url }}</p>")
        self.add("hello.md", "Hi.\n")
        build_site(self.config(template="page.html", base_url="/docs/"))
        self.assertEqual(self.read("hello", "index.html"), "<h1>Hello</h1><p>Hi.</p><p>/docs/</p>")

    def test_unknown_template_name(self):
        with self.assertRaisesRegex(BuildError, "unknown name 'site.author'"):
            apply_template("{{ site.author }}", {"site": {"title": "Notes"}})

    def test_index_limit_and_order(self):
        pages = [Page(slug=slug, title=slug.upper(), body="") for slug in ("pear", "apple", "fig")]
        html = index_html(self.config(index_limit=2), pages)
        self.assertEqual(
            html,
            '<ul>\n<li><a href="/apple/">APPLE</a></li>\n<li><a href="/fig/">FIG</a></li>\n</ul>',
        )


if __name__ == "__main__":
    unittest.main()
