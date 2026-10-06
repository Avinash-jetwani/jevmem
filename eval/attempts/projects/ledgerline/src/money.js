// Amounts are whole cents wrapped in Money, so a sum never goes through a float.

const AMOUNT = /^(-?\d+)(?:\.(\d{1,2}))?$/;

export class Money {
  #cents;

  constructor(cents) {
    if (!Number.isSafeInteger(cents)) {
      throw new TypeError(`cents must be a whole number, got ${cents}`);
    }
    this.#cents = cents;
  }

  // "12.34" -> 1234 cents, "-45" -> -4500 cents, "3.5" -> 350 cents.
  static parse(text) {
    const match = AMOUNT.exec(text.trim());
    if (!match) throw new SyntaxError(`not an amount: "${text}"`);
    const whole = Number(match[1]);
    const fraction = Number((match[2] ?? '').padEnd(2, '0'));
    return new Money(whole < 0 ? whole * 100 - fraction : whole * 100 + fraction);
  }

  get cents() {
    return this.#cents;
  }

  plus(other) {
    return new Money(this.#cents + other.#cents);
  }

  toString() {
    return formatAmount(this.#cents);
  }
}

export const ZERO = new Money(0);

// Accounting style: 123456 -> "1,234.56", -123456 -> "(1,234.56)".
export function formatAmount(cents) {
  const abs = Math.abs(cents);
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  const fraction = String(abs % 100).padStart(2, '0');
  return cents < 0 ? `(${whole}.${fraction})` : `${whole}.${fraction}`;
}
