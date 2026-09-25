# Agent notes

1. Migrations live in db/migrations and run with pnpm db:migrate.
2. Use pnpm for every install; npm lockfiles are rejected in review.

## Jevmem project memory

Durable project memory lives in `JEVMEM.md` and is served by the `jevmem` MCP server.

- Before any non-trivial task, call the `search_memory` tool.

## Testing

- Integration tests need Docker running locally.
