# gridwatch

Polls a fleet of sensor stations over HTTP, checks every reading against the
rules in `src/alerts.js`, and appends one JSON line to `alerts.jsonl` for each
rule that trips. One run is one polling cycle; cron starts it once a minute.

    node src/cli.js --url http://localhost:8080 --stations st-01,st-02 --out alerts.jsonl

- `src/client.js`: one request to one station
- `src/pool.js`, `src/poller.js`: one polling cycle over all stations
- `src/alerts.js`: the rules, the alert text and the alerts file
- `stub/station.js`: a local stand-in for a site gateway and its stations

## Tests

    npm test

Needs Node 22 and nothing else: no dependencies and no network. The tests start
`stub/station.js` on a free localhost port. The stub is kept in step with the
gateway firmware, so fix the code under test and leave the stub as it is.
