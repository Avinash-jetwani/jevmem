---
path: /install/
nav: Install
description: Add the jevmem plugin in the Claude app, install the CLI with npm install -g jevmem, save your TypeSafe API key with jevmem key, and run jevmem enable in your project.
order: 9
---
# How do I install jevmem?

Install jevmem in four steps: add the plugin in the Claude app (**Plugins → Discover → jevmem → Add**), install the CLI with `npm install -g jevmem`, save your TypeSafe API key with `jevmem key`, and run `jevmem enable` in your project's folder.

Once it runs, deciding what to save takes 0.25 s and costs $0.00016 per message, at TypeSafe's listed price for Jev (measured on 66 held-out turns with jevmem 0.6.6, one run on 2026-10-06, [results](../../results/eval-heldout-2026-10-06-v066.json)). The rest of this page is the repository's install and upgrade notes.

{{include docs/install.md}}

## Upgrading

{{include docs/upgrading.md}}
