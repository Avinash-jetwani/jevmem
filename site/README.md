# The docs site

The source of [avinash-jetwani.github.io/jevmem](https://avinash-jetwani.github.io/jevmem/): one page per question, written so that a person or an AI assistant gets the answer in the first sentence, with the number it rests on and a link to the results file.

```bash
node site/build.mjs     # builds into _site/
node site/serve.mjs     # serves it at http://localhost:4173/jevmem/
```

`.github/workflows/pages.yml` builds and publishes it on every push to `main`.

## How a page is made

- **`pages/*.md`**: one file per page. Front matter gives the `path`, the `description` (the meta description), the `order` and, for the header's menu, a `nav` label. The H1 is the question and the first paragraph is the answer.
- **Includes**: `{{include docs/install.md}}` puts a file of the repository in the page (without its H1), and `{{include README.md#install}}` the text under one heading. Most of each page comes from [README.md](../README.md) and [docs/](../docs), so the site says what the repository says. `{{versions}}` lists the [CHANGELOG](../CHANGELOG.md)'s entries.
- **Links** are written as they resolve in the repository, so they work on GitHub too. The build turns them into links to the site's page when one holds the target, and to the file on GitHub otherwise.
- **`partials/limits.md`** ends every page: the limits each page must link to.
- **`assets/`**: the stylesheet, the script (light and dark, search) and the cover image. The fonts, Inter and JetBrains Mono, are copied from their npm packages at build time and served from the site.

The build also writes a Markdown copy of every page (`/guard.md` beside `/guard/`), `llms-full.txt`, `sitemap.xml`, `robots.txt` and `search.json`, and copies [llms.txt](../llms.txt) from the repository's root after checking that it links every page.

## Rules

- A number on a page names what it was measured on and links its results file. `scripts/check-claims.mjs` reads these pages, and `test/site.test.ts` builds the site and checks its links, dates, JSON-LD and Markdown copies.
- No tracker, no analytics, no font or script from another host, no hidden text, and no text addressed to AI models.
- These pages are not in the npm package: `site/` is not in `package.json`'s `files`.
