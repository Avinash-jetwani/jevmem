# logslice

Slice and filter big log files from the command line.

```sh
logslice --grep "ERROR|WARN" --since 2026-03-01T08:00:00Z samples/app.log
logslice --format json samples/app.log
```

Options: `--grep <regex>`, `--since <time>` (ISO 8601, or relative like `2h`, `30m`), `--format text|json`.
