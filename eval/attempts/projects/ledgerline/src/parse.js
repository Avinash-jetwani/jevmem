import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { Money } from './money.js';
import { monthOf } from './months.js';

export const HEADER = 'date,category,amount,note';

// One CSV line -> its fields. A field may be wrapped in double quotes; inside
// quotes a comma is part of the field and "" stands for one double quote.
export function splitFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new SyntaxError('quote is never closed');
  fields.push(field);
  return fields;
}

// One data line -> one entry. lineNumber is the 1-based line in the file.
export function parseLine(line, lineNumber) {
  try {
    const fields = splitFields(line);
    if (fields.length !== 4) {
      throw new SyntaxError(`expected 4 fields, got ${fields.length}`);
    }
    const [date, category, amount, note] = fields;
    const name = category.trim();
    if (name === '') throw new SyntaxError('category is empty');
    return {
      line: lineNumber,
      date,
      month: monthOf(date),
      category: name,
      amount: Money.parse(amount),
      note,
    };
  } catch (error) {
    throw new Error(`line ${lineNumber}: ${error.message}`, { cause: error });
  }
}

// The whole ledger text -> entries, in file order. Blank lines are skipped.
export function parseLedger(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== HEADER) {
    throw new Error(`line 1: expected the header "${HEADER}"`);
  }
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    entries.push(parseLine(lines[i], i + 1));
  }
  return entries;
}

// Checks and reads through one descriptor, so the file that was checked is the
// file that is read.
export function readLedger(path) {
  const fd = openSync(path, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a file`);
    return parseLedger(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
