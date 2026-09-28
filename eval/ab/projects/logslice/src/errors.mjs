/** Report bad user input and exit with status 2 (usage error). */
export function fail(message) {
  process.stderr.write(`logslice: ${message}\n`);
  process.exit(2);
}
