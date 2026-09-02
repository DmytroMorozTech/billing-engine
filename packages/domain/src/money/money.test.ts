import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  InvalidAmountError,
  add,
  allocate,
  applyRate,
  applyRateExact,
  money,
  multiply,
  prorate,
  prorateExact,
  subtract,
  sum,
  toDecimalString,
  zero,
} from './money.js';
import { divideRound } from './rounding.js';

const eur = (amount: number) => money(amount, 'EUR');

describe('construction', () => {
  it('rejects non-integer amounts', () => {
    expect(() => eur(19.99)).toThrow(InvalidAmountError);
  });

  it('rejects amounts beyond safe integer range', () => {
    expect(() => eur(Number.MAX_SAFE_INTEGER + 1)).toThrow(InvalidAmountError);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(eur(100), money(100, 'GBP'))).toThrow(CurrencyMismatchError);
  });
});

describe('rounding mode', () => {
  it('rounds halves away from zero, symmetrically', () => {
    expect(divideRound(5n, 2n)).toBe(3n);
    expect(divideRound(-5n, 2n)).toBe(-3n);
    expect(divideRound(3n, 2n)).toBe(2n);
    expect(divideRound(1n, 2n)).toBe(1n);
    expect(divideRound(-1n, 2n)).toBe(-1n);
  });

  it('leaves exact quotients alone', () => {
    expect(divideRound(10n, 5n)).toBe(2n);
    expect(divideRound(0n, 5n)).toBe(0n);
  });
});

/**
 * ADR-0001 states that rounding is applied per line and the lines are then
 * summed. This test exists to prove the choice is real: the two orders give
 * different money, so picking one is a decision and not a formality.
 */
describe('rounding order matters', () => {
  const lines = [eur(1100), eur(1100), eur(1100)];
  const rate = 50; // 0.5%

  it('round-per-line then sum, which is what the system does', () => {
    const perLine = lines.map((line) => applyRate(line, rate));
    expect(perLine.map((m) => m.amount)).toEqual([6, 6, 6]);
    expect(sum(perLine, 'EUR').amount).toBe(18);
  });

  it('sum then round, which the system deliberately does not do', () => {
    expect(applyRate(sum(lines, 'EUR'), rate).amount).toBe(17);
  });
});

describe('applyRate', () => {
  it('applies basis points and rounds once', () => {
    // 413000 × 169 ÷ 10000 = 6979.70
    expect(applyRate(eur(413_000), 169).amount).toBe(6980);
    expect(applyRateExact(eur(413_000), 169)).toBe('6979.70');
  });

  it('handles large amounts that would overflow a double when multiplied', () => {
    const large = eur(1_000_000_000_000); // €10bn, well past 2^53 once × 10000
    expect(applyRate(large, 10_000).amount).toBe(1_000_000_000_000);
  });

  it('is exact for whole percentages', () => {
    expect(applyRate(eur(11_824), 1900).amount).toBe(2247); // 2246.56 → 2247
  });
});

describe('prorate', () => {
  it('takes a fraction of a period', () => {
    // €19 for 16 of 30 days = 1013.33 → 1013
    expect(prorate(eur(1900), 16, 30).amount).toBe(1013);
    expect(prorateExact(eur(1900), 16, 30)).toBe('1013.33');
  });

  it('refuses a zero-length period', () => {
    expect(() => prorate(eur(1900), 1, 0)).toThrow(RangeError);
  });
});

/**
 * The full worked example from ADR-0006: a merchant upgrades from Standard
 * (€0 / 1.69%) to Payments Plus (€19 / 0.99%) on 15 September, having already
 * processed €4 130 of volume at the old rate. Market DE, VAT 19%.
 *
 * If this test ever disagrees with the ADR, one of the two is wrong and the
 * discrepancy is the bug.
 */
describe('ADR-0006 worked example', () => {
  const subscription = prorate(eur(1900), 16, 30);
  const commissionStandard = applyRate(eur(413_000), 169);
  const commissionPlus = applyRate(eur(387_000), 99);
  const subtotal = sum([subscription, commissionStandard, commissionPlus], 'EUR');
  const vat = applyRate(subtotal, 1900);
  const total = add(subtotal, vat);

  it('produces the documented line items', () => {
    expect(subscription.amount).toBe(1013);
    expect(commissionStandard.amount).toBe(6980);
    expect(commissionPlus.amount).toBe(3831);
  });

  it('produces the documented totals', () => {
    expect(subtotal.amount).toBe(11_824);
    expect(vat.amount).toBe(2247);
    expect(total.amount).toBe(14_071);
    expect(toDecimalString(total)).toBe('140.71');
  });

  it('shows what the rejected retroactive rule would have undercharged', () => {
    // v1 "legacy": whole period repriced at the new rate.
    const v1 = applyRate(eur(800_000), 99);
    const v2 = add(commissionStandard, commissionPlus);

    expect(v1.amount).toBe(7920);
    expect(v2.amount).toBe(10_811);
    expect(subtract(v2, v1).amount).toBe(2891); // €28.91 undercharged by v1
  });
});

describe('allocate', () => {
  it('splits without creating or losing a unit', () => {
    const parts = allocate(eur(100), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([34, 33, 33]);
    expect(sum(parts, 'EUR').amount).toBe(100);
  });

  it('gives leftovers to the largest remainders, deterministically', () => {
    const parts = allocate(eur(1000), [3, 3, 4]);
    expect(sum(parts, 'EUR').amount).toBe(1000);
    expect(parts.map((p) => p.amount)).toEqual([300, 300, 400]);
  });

  it('handles negative amounts, as a credit note must', () => {
    const parts = allocate(eur(-100), [1, 1, 1]);
    expect(sum(parts, 'EUR').amount).toBe(-100);
  });

  it('rejects degenerate weights', () => {
    expect(() => allocate(eur(100), [])).toThrow(RangeError);
    expect(() => allocate(eur(100), [0, 0])).toThrow(RangeError);
    expect(() => allocate(eur(100), [-1, 2])).toThrow(RangeError);
  });
});

describe('minor units are currency-specific', () => {
  it('formats EUR with two decimals', () => {
    expect(toDecimalString(eur(6980))).toBe('69.80');
    expect(toDecimalString(eur(-6980))).toBe('-69.80');
    expect(toDecimalString(eur(5))).toBe('0.05');
  });

  it('formats JPY with none, because it has no minor unit', () => {
    expect(toDecimalString(money(6980, 'JPY'))).toBe('6980');
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(add(eur(1999), eur(1)).amount).toBe(2000);
    expect(subtract(eur(1999), eur(2000)).amount).toBe(-1);
    expect(multiply(eur(1999), 3).amount).toBe(5997);
  });

  it('sums an empty list to zero of the given currency', () => {
    expect(sum([], 'GBP')).toEqual(zero('GBP'));
  });
});
