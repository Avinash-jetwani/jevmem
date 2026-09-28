# shelfscan

Small tools for the ISBNs on book barcodes: validate an ISBN-10 or ISBN-13, and convert an ISBN-10 to its ISBN-13.

```
node src/cli.mjs check 0-306-40615-2
node src/cli.mjs to13 0306406152
```

`npm test` runs the tests in `test/` with Node's built-in runner.
