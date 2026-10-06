// Calendar maths on "YYYY-MM-DD" and "YYYY-MM" strings.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  return month === 2 && isLeapYear(year) ? 29 : DAYS[month - 1];
}

// "2025-03-14" -> "2025-03". Throws for anything that is not a day on the calendar.
export function monthOf(dateText) {
  const match = DATE.exec(dateText);
  if (!match) throw new RangeError(`not a date (YYYY-MM-DD): "${dateText}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`no such day: "${dateText}"`);
  }
  return dateText.slice(0, 7);
}

// "2025-12" -> "2026-01".
export function nextMonth(month) {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  if (index === 12) return `${year + 1}-01`;
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}

// Every month from first to last, both included.
export function monthsBetween(first, last) {
  const months = [];
  for (let month = first; month <= last; month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}
