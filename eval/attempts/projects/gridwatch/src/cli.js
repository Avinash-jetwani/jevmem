#!/usr/bin/env node
import { pollAll } from './poller.js';
import { evaluate, summarize, writeAlerts } from './alerts.js';

const USAGE = 'usage: gridwatch --url <base url> --stations <id,id,...> [--out <file>]';

function readArgs(argv) {
  const args = { out: 'alerts.jsonl' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--url') args.url = value;
    else if (flag === '--stations') args.stations = value.split(',').filter(Boolean);
    else if (flag === '--out') args.out = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!args.url || !args.stations?.length) throw new Error('--url and --stations are required');
  return args;
}

let args;
try {
  args = readArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

const { readings, failures, elapsedMs } = await pollAll(args.url, args.stations);
const alerts = evaluate(readings);
await writeAlerts(args.out, alerts);

for (const line of summarize(alerts)) console.log(line);
for (const { stationId, error } of failures) console.error(`${stationId}: ${error.message}`);
console.log(`read ${readings.length}, failed ${failures.length}, alerts ${alerts.length}, ${elapsedMs} ms`);

process.exitCode = failures.length > 0 ? 1 : 0;
