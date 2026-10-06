import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { categoryMatcher, renameCategories, snapshot } from '../src/entries.js';
import { Money, formatAmount } from '../src/money.js';
import { monthOf, monthsBetween, nextMonth } from '../src/months.js';
import { parseLedger, parseLine, splitFields } from '../src/parse.js';
import { monthlyTotals, renderReport, totalRows } from '../src/report.js';

const pathOf = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const BIN = pathOf('../bin/ledgerline.js');
const LEDGER = pathOf('fixtures/ledger.csv');
const GOLDEN = readFileSync(pathOf('fixtures/report.golden.txt'), 'utf8');

const SMALL = [
  'date,category,amount,note',
  '2025-01-03,food:groceries,-52.30,Weekly shop',
  '2025-01-09,food:eating-out,-38.40,"Dinner, two courses"',
  '2025-01-31,salary,3200.00,January pay',
  '',
  '2025-03-04,food:groceries,-57.80,',
  '2025-01-30,food:groceries,-21.48,Entered late',
].join('\n');

function run(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

describe('money', () => {
  test('parse reads whole cents', () => {
    assert.equal(Money.parse('12.34').cents, 1234);
    assert.equal(Money.parse('-12.34').cents, -1234);
    assert.equal(Money.parse('7').cents, 700);
    assert.equal(Money.parse('3.5').cents, 350);
    assert.equal(Money.parse('0.05').cents, 5);
    assert.equal(Money.parse('-45').cents, -4500);
    assert.equal(Money.parse(' 1150.00 ').cents, 115000);
  });

  test('parse rejects what is not a plain amount', () => {
    for (const text of ['', 'abc', '12abc', '1,234.50', '1.234', '1e3', '--5', '.5']) {
      assert.throws(() => Money.parse(text), SyntaxError, text);
    }
  });

  test('plus adds without changing either side', () => {
    const a = new Money(1010);
    const b = new Money(-2020);
    assert.equal(a.plus(b).cents, -1010);
    assert.equal(a.cents, 1010);
    assert.equal(b.cents, -2020);
  });

  test('the constructor takes whole cents only', () => {
    assert.throws(() => new Money(10.5), TypeError);
    assert.throws(() => new Money('10'), TypeError);
  });

  test('formatAmount groups thousands and wraps negatives in parentheses', () => {
    assert.equal(formatAmount(0), '0.00');
    assert.equal(formatAmount(5), '0.05');
    assert.equal(formatAmount(123456), '1,234.56');
    assert.equal(formatAmount(-41267), '(412.67)');
    assert.equal(formatAmount(-115000), '(1,150.00)');
    assert.equal(formatAmount(123456789), '1,234,567.89');
    assert.equal(String(new Money(-990)), '(9.90)');
  });
});

describe('months', () => {
  test('monthOf returns the month of a real day', () => {
    assert.equal(monthOf('2025-03-14'), '2025-03');
    assert.equal(monthOf('2024-02-29'), '2024-02');
    assert.equal(monthOf('2000-02-29'), '2000-02');
    assert.equal(monthOf('2025-12-31'), '2025-12');
  });

  test('monthOf rejects days that are not on the calendar', () => {
    for (const text of ['2025-02-29', '1900-02-29', '2025-02-30', '2025-04-31', '2025-13-01', '2025-00-10', '2025-06-00']) {
      assert.throws(() => monthOf(text), RangeError, text);
    }
  });

  test('monthOf rejects other date spellings', () => {
    for (const text of ['25-01-01', '2025-1-5', '2025/01/05', '05-01-2025', '2025-01-05T10:00', '']) {
      assert.throws(() => monthOf(text), RangeError, text);
    }
  });

  test('nextMonth and monthsBetween cross the year end', () => {
    assert.equal(nextMonth('2025-01'), '2025-02');
    assert.equal(nextMonth('2025-09'), '2025-10');
    assert.equal(nextMonth('2025-12'), '2026-01');
    assert.deepEqual(monthsBetween('2024-11', '2025-02'), ['2024-11', '2024-12', '2025-01', '2025-02']);
    assert.deepEqual(monthsBetween('2025-05', '2025-05'), ['2025-05']);
  });
});

describe('parse', () => {
  test('splitFields splits on commas', () => {
    assert.deepEqual(splitFields('2025-01-03,food:groceries,-52.30,Weekly shop'), [
      '2025-01-03', 'food:groceries', '-52.30', 'Weekly shop',
    ]);
    assert.deepEqual(splitFields('a,,c,'), ['a', '', 'c', '']);
  });

  test('splitFields keeps commas and quotes inside a quoted field', () => {
    assert.deepEqual(splitFields('2025-01-09,food:eating-out,-38.40,"Dinner, two courses"'), [
      '2025-01-09', 'food:eating-out', '-38.40', 'Dinner, two courses',
    ]);
    assert.deepEqual(splitFields('x,"The ""Lantern"" cafe"'), ['x', 'The "Lantern" cafe']);
    assert.throws(() => splitFields('x,"never closed'), SyntaxError);
  });

  test('parseLine builds an entry', () => {
    const entry = parseLine('2025-01-09,food:eating-out,-38.40,"Dinner, two courses"', 8);
    assert.equal(entry.line, 8);
    assert.equal(entry.date, '2025-01-09');
    assert.equal(entry.month, '2025-01');
    assert.equal(entry.category, 'food:eating-out');
    assert.equal(entry.amount.cents, -3840);
    assert.equal(entry.note, 'Dinner, two courses');
  });

  test('parseLine names the line in its errors', () => {
    assert.throws(() => parseLine('2025-01-09,rent,-10.00', 4), /^Error: line 4: expected 4 fields, got 3$/);
    assert.throws(() => parseLine('2025-02-30,rent,-10.00,', 5), /^Error: line 5: no such day/);
    assert.throws(() => parseLine('2025-01-09,rent,ten,', 6), /^Error: line 6: not an amount/);
    assert.throws(() => parseLine('2025-01-09, ,-10.00,', 7), /^Error: line 7: category is empty$/);
  });

  test('parseLedger wants the header and skips blank lines', () => {
    const entries = parseLedger(SMALL);
    assert.equal(entries.length, 5);
    assert.deepEqual(entries.map((entry) => entry.line), [2, 3, 4, 6, 7]);
    assert.throws(() => parseLedger('2025-01-03,food:groceries,-52.30,\n'), /line 1: expected the header/);
  });

  test('parseLedger reads Windows line ends', () => {
    const entries = parseLedger(SMALL.replaceAll('\n', '\r\n'));
    assert.equal(entries.length, 5);
    assert.equal(entries[0].note, 'Weekly shop');
  });
});

describe('entries', () => {
  test('categoryMatcher treats * as a wildcard and the rest literally', () => {
    const food = categoryMatcher('food:*');
    assert.equal(food('food:groceries'), true);
    assert.equal(food('food:'), true);
    assert.equal(food('seafood:market'), false);
    assert.equal(categoryMatcher('*rent')('home:rent'), true);
    assert.equal(categoryMatcher('salary')('salary'), true);
    assert.equal(categoryMatcher('salary')('salary:bonus'), false);
    assert.equal(categoryMatcher('tax+ni (2025)')('tax+ni (2025)'), true);
    assert.equal(categoryMatcher('tax+ni (2025)')('taxxni 2025'), false);
    assert.equal(categoryMatcher('a.c')('abc'), false);
  });

  test('snapshot gives rows that can change on their own', () => {
    const entries = parseLedger(SMALL);
    const copies = snapshot(entries);
    copies[0].category = 'changed';
    copies[0].note = 'changed';
    assert.equal(entries[0].category, 'food:groceries');
    assert.equal(entries[0].note, 'Weekly shop');
    assert.equal(copies.length, entries.length);
    assert.equal(copies[1].amount.cents, -3840);
    assert.equal(String(copies[2].amount), '3,200.00');
  });

  test('renameCategories renames copies and the totals follow', () => {
    const entries = parseLedger(SMALL);
    const renamed = renameCategories(entries, new Map([['food:eating-out', 'food:groceries']]));
    assert.equal(entries[1].category, 'food:eating-out');
    assert.equal(renamed[1].category, 'food:groceries');
    const january = monthlyTotals(renamed).get('2025-01');
    assert.deepEqual(Array.from(january.keys()), ['food:groceries', 'salary']);
    assert.equal(january.get('food:groceries').cents, -5230 - 3840 - 2148);
  });
});

describe('report', () => {
  test('monthlyTotals sums per month and category', () => {
    const totals = monthlyTotals(parseLedger(SMALL));
    assert.deepEqual(Array.from(totals.keys()), ['2025-01', '2025-03']);
    assert.equal(totals.get('2025-01').get('food:groceries').cents, -7378);
    assert.equal(totals.get('2025-01').get('food:eating-out').cents, -3840);
    assert.equal(totals.get('2025-01').get('salary').cents, 320000);
    assert.equal(totals.get('2025-03').get('food:groceries').cents, -5780);
  });

  test('renderReport lists every month between the first and the last', () => {
    const report = renderReport(monthlyTotals(parseLedger(SMALL)));
    assert.equal(report, [
      'ledgerline report: 2025-01 to 2025-03',
      '',
      '2025-01',
      '       (38.40)  food:eating-out',
      '       (73.78)  food:groceries',
      '     3,200.00   salary',
      '  -----------',
      '     3,087.82   net',
      '',
      '2025-02',
      '  (no entries)',
      '',
      '2025-03',
      '       (57.80)  food:groceries',
      '  -----------',
      '       (57.80)  net',
      '',
    ].join('\n'));
  });

  test('renderReport copes with an empty ledger', () => {
    assert.equal(renderReport(monthlyTotals([])), 'ledgerline report: no entries\n');
  });

  test('totalRows is ordered by month, then category', () => {
    assert.deepEqual(totalRows(monthlyTotals(parseLedger(SMALL))), [
      { month: '2025-01', category: 'food:eating-out', cents: -3840 },
      { month: '2025-01', category: 'food:groceries', cents: -7378 },
      { month: '2025-01', category: 'salary', cents: 320000 },
      { month: '2025-03', category: 'food:groceries', cents: -5780 },
    ]);
  });
});

describe('cli', () => {
  test('prints the golden report for the fixture ledger', () => {
    const result = run(LEDGER);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, GOLDEN);
    assert.equal(result.status, 0);
  });

  test('--category keeps the matching categories', () => {
    const result = run(LEDGER, '--category', 'food:*', '--json');
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows.map((row) => `${row.month} ${row.category} ${row.cents}`), [
      '2025-01 food:eating-out -7490',
      '2025-01 food:groceries -24272',
      '2025-02 food:eating-out -8400',
      '2025-02 food:groceries -23652',
      '2025-03 food:eating-out -2750',
      '2025-03 food:groceries -23688',
    ]);
  });

  test('--rename merges categories before the totals', () => {
    const result = run(LEDGER, '--rename', 'food:eating-out=food', '--rename', 'food:groceries=food', '--category', 'food', '--json');
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), [
      { month: '2025-01', category: 'food', cents: -31762 },
      { month: '2025-02', category: 'food', cents: -32052 },
      { month: '2025-03', category: 'food', cents: -26438 },
    ]);
  });

  test('a bad ledger or a bad command line exits with 1 and a message', () => {
    const missing = run(pathOf('fixtures/none.csv'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^ledgerline: .*no such file/);

    const folder = run(pathOf('fixtures'));
    assert.equal(folder.status, 1);
    assert.match(folder.stderr, /is not a file/);

    const noFile = run('--json');
    assert.equal(noFile.status, 1);
    assert.match(noFile.stderr, /usage: ledgerline/);

    const unknown = run(LEDGER, '--yearly');
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /usage: ledgerline/);
  });
});
