---
path: /install/
nav: Install
description: Add the jevmem plugin in the Claude app, install the CLI with npm install -g jevmem, and run jevmem setup in your project, which asks for your TypeSafe API key and turns jevmem on there.
order: 10
---
# How do I install jevmem?

Install jevmem in three steps: add the plugin in the Claude app (**Plugins → Discover → jevmem → Add**), install the CLI with `npm install -g jevmem`, and run `jevmem setup` in your project's folder, which asks for your TypeSafe API key without showing it, turns jevmem on there and checks the setup. If you start Claude Code before that is done, the plugin says once what is left.

Once it runs, deciding what to save takes 0.24 s and costs $0.00018 per message, at TypeSafe's listed price for Jev (measured on 66 held-out turns with jevmem 0.7.6, one run on 2026-10-19, [results](../../results/eval-heldout-2026-10-19-v076.json)). The rest of this page is the repository's install and upgrade notes.

{{include docs/install.md}}

## Upgrading

{{include docs/upgrading.md}}
