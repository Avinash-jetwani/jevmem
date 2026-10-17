# jevmem pane

A side pane for Claude Code, beside your chat, that shows what [jevmem](https://github.com/Avinash-jetwani/jevmem) did for the prompt you just sent and the turn that just ended:

1. **Recalled for this prompt**: each memory line served to Claude (its id, kind and text) and how many were withheld.
2. **The guard**: the last call the guard asked about or denied, with the rule and its score, matched to the call.
3. **Saved last turn**: the line jevmem saved from the turn and its kind, or why the turn was skipped.

Each line has `why`, `wrong` and `forget` buttons. `forget` and `wrong` change `JEVMEM.md` (the line is kept as `[retired]`), so they ask first; a rule is retired in a terminal only, as `jevmem trust` works. The pane reads three local files under `.jevmem/` and runs the `jevmem` command by argument vector; it sends nothing anywhere and reads no key.

## Install

In Claude Code, with the jevmem marketplace added (`claude plugin marketplace add Avinash-jetwani/jevmem`):

```
/plugin install jevmem-pane@jevmem
```

It needs the jevmem command (`npm install -g jevmem`) and a project that is turned on (`jevmem setup`). The pane opens on its own in a terminal 144 columns wide or wider; `/jevmem` opens or closes it at any width (docked beside the chat from 110 columns in the fullscreen terminal, above the prompt below that). Claude Code only: Cursor has no pane.

The whole description, with what each state means, is in [docs/pane.md](https://avinash-jetwani.github.io/jevmem/pane/).
