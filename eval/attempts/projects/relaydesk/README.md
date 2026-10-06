# relaydesk

A small job queue for one machine. Jobs live in a single JSON file. A worker claims a
job with a lease; a job that fails, or whose lease runs out, is tried again with
exponential backoff until its attempts are used up.

    node src/cli.js enqueue mail '{"to":"ops"}'
    node src/cli.js claim --lease 30000
    node src/cli.js done <id>
    node src/cli.js list

The store path comes from `RELAYDESK_DB` (default `./relaydesk.json`). A `.env` file in
the working directory is read at start; variables already set in the environment win.
Other settings: `RELAYDESK_LEASE_MS` (30000), `RELAYDESK_MAX_ATTEMPTS` (3),
`RELAYDESK_BACKOFF_BASE_MS` (1000) and `RELAYDESK_BACKOFF_CAP_MS` (3600000).

Needs Node 22 or newer and nothing else. To run the tests and the benchmark:

    npm test         # node --test
    npm run bench    # enqueue, claim and complete 300 jobs; prints jobs/s
