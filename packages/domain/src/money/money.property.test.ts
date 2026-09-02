import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { add, allocate, applyRate, money, negate, subtract, sum } from './money.js';
import { divideRound } from './rounding.js';

/** Amounts well inside the safe-integer range, so sums cannot overflow. */
const amount = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
const positiveAmount = fc.integer({ min: 0, max: 1_000_000_000 });
const weights = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 20 });
const basisPoints = fc.integer({ min: 0, max: 10_000 });

describe('allocate never creates or destroys money', () => {
  it('parts always sum back to the original', () => {
    fc.assert(
      fc.property(amount, weights, (value, ws) => {
        fc.pre(ws.reduce((a, b) => a + b, 0) > 0);

        const original = money(value, 'EUR');
        const parts = allocate(original, ws);

        expect(sum(parts, 'EUR').amount).toBe(original.amount);
        expect(parts).toHaveLength(ws.length);
      }),
    );
  });

  it('is deterministic — the same inputs give byte-identical output', () => {
    fc.assert(
      fc.property(amount, weights, (value, ws) => {
        fc.pre(ws.reduce((a, b) => a + b, 0) > 0);

        const original = money(value, 'EUR');
        expect(allocate(original, ws)).toEqual(allocate(original, ws));
      }),
    );
  });
});

describe('addition and subtraction are inverses', () => {
  it('a + b - b === a', () => {
    fc.assert(
      fc.property(amount, amount, (x, y) => {
        const a = money(x, 'EUR');
        const b = money(y, 'EUR');
        expect(subtract(add(a, b), b)).toEqual(a);
      }),
    );
  });

  it('summing is order-independent', () => {
    fc.assert(
      fc.property(fc.array(amount, { maxLength: 30 }), (values) => {
        const forward = sum(
          values.map((v) => money(v, 'EUR')),
          'EUR',
        );
        const backward = sum(
          [...values].reverse().map((v) => money(v, 'EUR')),
          'EUR',
        );
        expect(forward).toEqual(backward);
      }),
    );
  });
});

describe('rounding is symmetric about zero', () => {
  it('applying a rate to -x gives the negation of applying it to x', () => {
    fc.assert(
      fc.property(amount, basisPoints, (value, rate) => {
        const positive = applyRate(money(value, 'EUR'), rate);
        const negative = applyRate(negate(money(value, 'EUR')), rate);
        expect(negative).toEqual(negate(positive));
      }),
    );
  });

  it('never rounds further than half a unit away from the true quotient', () => {
    fc.assert(
      fc.property(positiveAmount, basisPoints, (value, rate) => {
        const numerator = BigInt(value) * BigInt(rate);
        const rounded = divideRound(numerator, 10_000n);
        const error = numerator - rounded * 10_000n;
        const magnitude = error < 0n ? -error : error;

        expect(magnitude * 2n <= 10_000n).toBe(true);
      }),
    );
  });
});

describe('applying a rate is monotonic', () => {
  it('a larger amount never yields a smaller charge', () => {
    fc.assert(
      fc.property(positiveAmount, positiveAmount, basisPoints, (x, y, rate) => {
        const smaller = Math.min(x, y);
        const larger = Math.max(x, y);

        const chargedForSmaller = applyRate(money(smaller, 'EUR'), rate).amount;
        const chargedForLarger = applyRate(money(larger, 'EUR'), rate).amount;

        expect(chargedForLarger).toBeGreaterThanOrEqual(chargedForSmaller);
      }),
    );
  });
});
