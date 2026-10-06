# ledgerline

Reads a CSV ledger of dated transactions and prints the total per category for
every month, as plain text or as JSON.

    node bin/ledgerline.js ledger.csv
    node bin/ledgerline.js ledger.csv --category 'food:*' --json
    node bin/ledgerline.js ledger.csv --rename food:coffee=food:eating-out

The ledger starts with the header `date,category,amount,note`. Dates are
YYYY-MM-DD, spending is negative and income is positive.

It needs Node 22 and nothing else: no dependencies, no build step, no flags.

    npm test         # node --test, with the golden report in test/fixtures
    npm run bench    # times parse, totals and render on 200,000 generated rows

`test/fixtures/report.golden.txt` is the agreed layout of the report. Change it
only when the layout is meant to change.
