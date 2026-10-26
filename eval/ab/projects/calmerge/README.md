# calmerge

Merges several iCalendar feeds (URLs or `.ics` files) into one calendar and prints a listing of what is in it. No
dependencies; Node 22 and its standard library only.

```
calmerge https://cal.example/work.ics samples/home.ics
calmerge --name "Everything" https://cal.example/work.ics samples/home.ics
```

## Layout

- `bin/calmerge.mjs` only calls `main()` from `src/cli.mjs`.
- `src/cli.mjs` parses the arguments, reads the feeds one after another and prints the listing.
- `src/fetch.mjs` reads one feed (an `http(s)` URL with a 10-second timeout, or a file).
- `src/ics.mjs` unfolds and parses iCalendar text into events, and writes events back out as iCalendar.
- `src/merge.mjs` merges the feeds' events, de-duplicated by `UID`, sorted by start.
- `src/time.mjs` reads `DTSTART`/`DTEND` values (UTC `Z`, floating, and all-day `VALUE=DATE`).
- `src/output.mjs` formats the listing.
- `test/` uses `node --test`.
