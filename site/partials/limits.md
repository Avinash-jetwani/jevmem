## The limits, in short

- jevmem needs a TypeSafe API key ([where to get one, and the install steps](../pages/install.md)).
- Message text is sent to TypeSafe to be scored, with common secrets scrubbed first ([what leaves your machine](../pages/privacy.md)).
- It is automatic in Claude Code and, since 0.7.4, in Cursor, automatic in Codex while `jevmem watch` runs, and in Claude Desktop only when the agent calls it; in Cursor, bringing lines back is still the agent's call ([what each tool does](../pages/install.md#works-with)).
- Rules every task must follow reach every session only when they are marked always-on (0.7.1), by Jev's reading or yours ([jevmem next to CLAUDE.md](../pages/compare.md)).
- The guard is a backstop, not a sandbox ([what it misses](../pages/guard.md#limits)).

Every limit, with the numbers: [the FAQ](../pages/faq.md#what-are-jevmems-limits).
