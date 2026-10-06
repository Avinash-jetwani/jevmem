# pagewright

A tiny static-site generator. Each Markdown file in a site's content directory
becomes `<slug>/index.html`, and a front page lists them all. Files may start
with front matter (`title`, `date`, `tags`, `slug`, `draft`) between two `---`
lines. The Markdown subset is headings, paragraphs, `-` lists, `>` quotes,
fenced code, and inline bold, italics, code and links.

Runs on Python 3.9, the `python3` that ships with macOS. Standard library only:
there is nothing to install.

    python3 -m pagewright example/site.json   # build the example into example/public/
    python3 -m unittest                       # run the tests
    python3 bench.py                          # time escape() and a 200-page build

A site is a JSON config (`title`, `base_url`, `content_dir`, `output_dir`,
`template`, `index_limit`, `nav`) next to its content. The page template uses
`{{ name }}` placeholders; `pagewright/build.py` holds the default one.
