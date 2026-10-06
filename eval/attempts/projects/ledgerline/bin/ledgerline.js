#!/usr/bin/env node
import { categoryMatcher, renameCategories } from '../src/entries.js';
import { readLedger } from '../src/parse.js';
import { monthlyTotals, renderReport, totalRows } from '../src/report.js';

const USAGE =
  'usage: ledgerline <ledger.csv> [--json] [--category <glob>] [--rename <old>=<new>]...';

function readOptions(argv) {
  const options = { file: null, json: false, category: null, renames: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--category' || arg === '--rename') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--category') {
        options.category = value;
      } else {
        const at = value.indexOf('=');
        if (at < 1 || at === value.length - 1) {
          throw new Error(`--rename wants <old>=<new>, got "${value}"`);
        }
        options.renames.set(value.slice(0, at), value.slice(at + 1));
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (options.file === null) {
      options.file = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  if (options.file === null) throw new Error('no ledger file given');
  return options;
}

function main(argv) {
  let options;
  try {
    options = readOptions(argv);
  } catch (error) {
    process.stderr.write(`ledgerline: ${error.message}\n${USAGE}\n`);
    return 1;
  }
  try {
    let entries = readLedger(options.file);
    if (options.renames.size > 0) entries = renameCategories(entries, options.renames);
    if (options.category !== null) {
      const matches = categoryMatcher(options.category);
      entries = entries.filter((entry) => matches(entry.category));
    }
    const totals = monthlyTotals(entries);
    process.stdout.write(
      options.json ? `${JSON.stringify(totalRows(totals), null, 2)}\n` : renderReport(totals),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`ledgerline: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
