---
path: /pane/
nav: The pane
description: Yes. jevmem's side pane (0.7.5) sits beside your Claude Code chat and shows, for each prompt and turn, the memory lines it gave Claude, what its guard said about a command, and the line it saved, with why, wrong and forget buttons.
order: 7
---
# Can I see what jevmem recalled and saved, beside my Claude Code chat?

Yes, since jevmem 0.7.5: the side pane, a second plugin from the jevmem marketplace, sits beside your Claude Code chat and shows what jevmem did for the prompt you just sent and the turn that just ended: which memory lines it gave Claude, what its guard said about a command, and what it saved, each with `why`, `wrong` and `forget` buttons. It reads three local files and sends nothing anywhere.

```
/plugin install jevmem-pane@jevmem
```

It needs the jevmem command (0.7.5 or newer), a project that is turned on, and Claude Code 2.1.299 or newer. In a terminal 144 columns wide or wider it opens on its own; `/jevmem` opens or closes it at any width. In the desktop app's Code tab it docks beside the chat. Cursor has no pane, and Claude Code for VS Code draws none yet.

{{include docs/pane.md}}
