// npm run bench [rows]: times each stage on a generated ledger.
// Prints the median of seven timed runs per stage, after two warm-up runs.
import { parseLedger } from '../src/parse.js';
import { monthlyTotals, renderReport } from '../src/report.js';

const CATEGORIES = [
  'ISA', 'salary', 'transport', 'home:rent', 'home:utilities', 'home:repairs',
  'food:groceries', 'food:eating-out', 'food:coffee', 'health', 'gifts',
  'clothes', 'books', 'phone', 'travel', 'fees',
];
const NOTES = [
  'Weekly shop at the market on the corner',
  'Monthly direct debit for the flat',
  '"Card payment, contactless"',
  'Refund for a cancelled booking',
  'Transfer to the savings account',
  '',
];

// Ten years of entries, the same ones on every run.
function generate(rows) {
  let seed = 20250101;
  const next = (limit) => {
    seed = (seed * 48271) % 2147483647;
    return seed % limit;
  };
  const two = (n) => String(n).padStart(2, '0');
  const lines = ['date,category,amount,note'];
  for (let i = 0; i < rows; i++) {
    const date = `${2015 + next(10)}-${two(1 + next(12))}-${two(1 + next(28))}`;
    const sign = next(5) === 0 ? '' : '-';
    const amount = `${sign}${1 + next(900)}.${two(next(100))}`;
    lines.push(`${date},${CATEGORIES[next(CATEGORIES.length)]},${amount},${NOTES[next(NOTES.length)]}`);
  }
  return `${lines.join('\n')}\n`;
}

function median(fn) {
  fn();
  fn();
  const times = [];
  for (let run = 0; run < 7; run++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[3];
}

const rows = Number(process.argv[2] ?? 200000);
const text = generate(rows);
const entries = parseLedger(text);
const totals = monthlyTotals(entries);

const show = (label, ms) => console.log(`${label.padEnd(8)}${ms.toFixed(1).padStart(8)} ms`);
console.log(`rows    ${String(rows).padStart(8)}`);
show('parse', median(() => parseLedger(text)));
show('totals', median(() => monthlyTotals(entries)));
show('render', median(() => renderReport(totals)));
