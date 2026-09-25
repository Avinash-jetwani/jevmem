# Orchard

Welcome to the Orchard repo, hello!

Orchard is a Remix app backed by Postgres 16. Background jobs run on BullMQ.

## Rules

- Use pnpm for every install; npm lockfiles are rejected in review.
- **Never** commit files from the `secrets/` folder.
- Keep API handlers under 200 lines.
- ok

```bash
pnpm dev   # this is a code block, not a rule
```

<!-- Maintainers: this comment is not a rule. -->

| Command | What |
|---|---|
| pnpm test | runs vitest |

@docs/architecture.md
