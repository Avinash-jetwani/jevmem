import { ZERO, formatAmount } from './money.js';
import { monthsBetween } from './months.js';

const WIDTH = 14;

// entries -> Map of month -> Map of category -> Money.
export function monthlyTotals(entries) {
  const totals = new Map();
  for (const entry of entries) {
    let byCategory = totals.get(entry.month);
    if (byCategory === undefined) {
      byCategory = new Map();
      totals.set(entry.month, byCategory);
    }
    const sum = byCategory.get(entry.category);
    if (sum === undefined) {
      byCategory.set(entry.category, entry.amount);
    } else {
      byCategory.set(entry.category, sum.plus(entry.amount));
    }
  }
  return totals;
}

// Right-aligned amount; the digits of positive and negative amounts line up.
function cell(money) {
  const text = formatAmount(money.cents);
  return (money.cents < 0 ? text : `${text} `).padStart(WIDTH);
}

// totals -> the plain-text report. Every month from the first to the last is
// listed, also the ones without entries.
export function renderReport(totals) {
  const present = Array.from(totals.keys());
  present.sort();
  if (present.length === 0) return 'ledgerline report: no entries\n';

  const months = monthsBetween(present[0], present[present.length - 1]);
  const lines = [`ledgerline report: ${months[0]} to ${months[months.length - 1]}`];
  for (const month of months) {
    lines.push('', month);
    const byCategory = totals.get(month);
    if (byCategory === undefined) {
      lines.push('  (no entries)');
      continue;
    }
    const names = Array.from(byCategory.keys());
    names.sort();
    let net = ZERO;
    for (const name of names) {
      const sum = byCategory.get(name);
      net = net.plus(sum);
      lines.push(`${cell(sum)}  ${name}`);
    }
    lines.push('-'.repeat(11).padStart(WIDTH - 1), `${cell(net)}  net`);
  }
  return `${lines.join('\n')}\n`;
}

// totals -> flat rows for --json, ordered by month and then by category.
export function totalRows(totals) {
  const rows = [];
  for (const [month, byCategory] of totals) {
    for (const [category, sum] of byCategory) {
      rows.push({ month, category, cents: sum.cents });
    }
  }
  rows.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return 0;
  });
  return rows;
}
