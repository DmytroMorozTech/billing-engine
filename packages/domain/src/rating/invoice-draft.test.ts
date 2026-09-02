import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { applyRate, money, subtract, toDecimalString } from '../money/money.js';
import { flatten } from './derivation.js';
import { buildInvoice, type RatedTransaction } from './invoice-draft.js';
import { RateCoverageError, type RateInterval, segmentPeriod } from './rate-interval.js';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

const SEPTEMBER = { start: date('2026-09-01'), end: date('2026-10-01') };

const standard: RateInterval = {
  id: 'ri_standard',
  planId: 'standard',
  monthlyFee: eur(0),
  rates: { in_person: 169, online: 250, moto: 295 },
  motoFixedFee: eur(25),
  effectiveFrom: date('2026-01-31'),
  effectiveTo: date('2026-09-15'),
};

const plus: RateInterval = {
  id: 'ri_plus',
  planId: 'payments_plus',
  monthlyFee: eur(1900),
  rates: { in_person: 99, online: 250, moto: 295 },
  motoFixedFee: eur(25),
  effectiveFrom: date('2026-09-15'),
  effectiveTo: null,
};

function transaction(
  id: string,
  amount: number,
  on: string,
  channel: RatedTransaction['channel'] = 'in_person',
): RatedTransaction {
  return { id, gross: eur(amount), channel, occurredOn: date(on) };
}

describe('segmentPeriod', () => {
  it('splits a period at a mid-cycle plan change', () => {
    const segments = segmentPeriod(SEPTEMBER, [standard, plus]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ from: date('2026-09-01'), to: date('2026-09-15'), days: 14 });
    expect(segments[1]).toMatchObject({ from: date('2026-09-15'), to: date('2026-10-01'), days: 16 });
    expect((segments[0]?.days ?? 0) + (segments[1]?.days ?? 0)).toBe(30);
  });

  it('returns a single segment when nothing changed', () => {
    const segments = segmentPeriod(SEPTEMBER, [{ ...standard, effectiveTo: null }]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.days).toBe(30);
  });

  it('ignores intervals that fall outside the period', () => {
    const ancient: RateInterval = {
      ...standard,
      id: 'ri_old',
      effectiveFrom: date('2025-01-01'),
      effectiveTo: date('2025-06-01'),
    };
    expect(segmentPeriod(SEPTEMBER, [ancient, { ...standard, effectiveTo: null }])).toHaveLength(1);
  });

  it('refuses to invent a rate for an uncovered gap', () => {
    const late: RateInterval = { ...plus, effectiveFrom: date('2026-09-20') };
    // Nothing is in force between the 15th and the 20th. Filling that in would
    // turn a broken timeline into a silently wrong invoice.
    expect(() => segmentPeriod(SEPTEMBER, [standard, late])).toThrow(RateCoverageError);
  });

  it('refuses when nothing covers the period at all', () => {
    expect(() => segmentPeriod(SEPTEMBER, [])).toThrow(RateCoverageError);
  });
});

/**
 * The worked example from ADR-0006, end to end. If this test and the ADR ever
 * disagree, one of them is wrong and the difference is the bug.
 */
describe('ADR-0006 worked example', () => {
  const transactions: RatedTransaction[] = [
    transaction('t1', 413_000, '2026-09-10'),
    transaction('t2', 387_000, '2026-09-20'),
  ];

  const invoice = buildInvoice({
    period: SEPTEMBER,
    currency: 'EUR',
    intervals: [standard, plus],
    transactions,
    vatRateBps: 1900,
  });

  it('produces the documented lines, in order', () => {
    expect(invoice.lines.map((line) => [line.kind, line.amount.amount])).toEqual([
      ['subscription', 1013],
      ['commission', 6980],
      ['commission', 3831],
    ]);
  });

  it('omits a line for the free plan but keeps its commission', () => {
    // Standard costs €0, so no subscription line — but the 1.69% it bought is
    // still charged, and still explained.
    const subscriptionLines = invoice.lines.filter((line) => line.kind === 'subscription');
    expect(subscriptionLines).toHaveLength(1);
    expect(subscriptionLines[0]?.description).toContain('payments_plus');
  });

  it('produces the documented totals', () => {
    expect(invoice.subtotal.amount).toBe(11_824);
    expect(invoice.vat.amount).toBe(2247);
    expect(invoice.total.amount).toBe(14_071);
    expect(toDecimalString(invoice.total)).toBe('140.71');
  });

  it('records the pre-rounding value on every rounded line', () => {
    const rounding = invoice.lines.map((line) => line.derivation.rounding?.exact);
    expect(rounding).toEqual(['1013.33', '6979.70', '3831.30']);
  });

  it('explains each commission line with the volume and rate that produced it', () => {
    const line = invoice.lines[1];
    const inputs = flatten(line!.derivation);

    expect(line?.derivation.formula).toBe('volume × rate');
    expect(inputs).toContainEqual(
      expect.objectContaining({ label: 'Rate', value: '169 bps = 1.69%' }),
    );
    expect(inputs).toContainEqual(
      expect.objectContaining({ value: { amount: 413_000, currency: 'EUR' } }),
    );
  });

  it('shows what the rejected retroactive rule would have undercharged', () => {
    // v1 "legacy": the whole period repriced at the new rate.
    const v1 = applyRate(eur(800_000), 99);
    const v2 = invoice.lines
      .filter((line) => line.kind === 'commission')
      .reduce((total, line) => total + line.amount.amount, 0);

    expect(v1.amount).toBe(7920);
    expect(v2).toBe(10_811);
    expect(subtract(eur(v2), v1).amount).toBe(2891);
  });
});

describe('channels', () => {
  it('prices each channel at its own rate within the same segment', () => {
    const invoice = buildInvoice({
      period: SEPTEMBER,
      currency: 'EUR',
      intervals: [{ ...standard, effectiveTo: null }],
      transactions: [
        transaction('t1', 100_000, '2026-09-05', 'in_person'),
        transaction('t2', 100_000, '2026-09-06', 'online'),
      ],
      vatRateBps: 1900,
    });

    expect(invoice.lines.map((line) => line.amount.amount)).toEqual([
      1690, // 100000 × 169 ÷ 10000
      2500, // 100000 × 250 ÷ 10000
    ]);
  });

  it('adds the flat MOTO fee once per transaction, not once per line', () => {
    const invoice = buildInvoice({
      period: SEPTEMBER,
      currency: 'EUR',
      intervals: [{ ...standard, effectiveTo: null }],
      transactions: [
        transaction('t1', 10_000, '2026-09-05', 'moto'),
        transaction('t2', 10_000, '2026-09-06', 'moto'),
        transaction('t3', 10_000, '2026-09-07', 'moto'),
      ],
      vatRateBps: 1900,
    });

    // 30000 × 295 ÷ 10000 = 885, plus 3 × 25 = 75.
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]?.amount.amount).toBe(960);
    expect(invoice.lines[0]?.derivation.formula).toBe(
      'volume × rate + fixed fee × transactions',
    );
  });
});

describe('boundaries', () => {
  it('prices a transaction on the change date at the new rate', () => {
    // The segment is half-open: 15 September belongs to the new interval.
    const invoice = buildInvoice({
      period: SEPTEMBER,
      currency: 'EUR',
      intervals: [standard, plus],
      transactions: [transaction('t1', 100_000, '2026-09-15')],
      vatRateBps: 1900,
    });

    const commission = invoice.lines.filter((line) => line.kind === 'commission');
    expect(commission).toHaveLength(1);
    expect(commission[0]?.amount.amount).toBe(990); // 0.99%, not 1.69%
  });

  it('prices the day before the change at the old rate', () => {
    const invoice = buildInvoice({
      period: SEPTEMBER,
      currency: 'EUR',
      intervals: [standard, plus],
      transactions: [transaction('t1', 100_000, '2026-09-14')],
      vatRateBps: 1900,
    });

    const commission = invoice.lines.filter((line) => line.kind === 'commission');
    expect(commission[0]?.amount.amount).toBe(1690);
  });

  it('produces an empty invoice for a period with no volume and a free plan', () => {
    const invoice = buildInvoice({
      period: SEPTEMBER,
      currency: 'EUR',
      intervals: [{ ...standard, effectiveTo: null }],
      transactions: [],
      vatRateBps: 1900,
    });

    expect(invoice.lines).toHaveLength(0);
    expect(invoice.total.amount).toBe(0);
  });
});

describe('reproducibility', () => {
  it('recomputing a period gives a byte-identical invoice', () => {
    const input = {
      period: SEPTEMBER,
      currency: 'EUR' as const,
      intervals: [standard, plus],
      transactions: [transaction('t1', 413_000, '2026-09-10'), transaction('t2', 387_000, '2026-09-20')],
      vatRateBps: 1900,
    };

    expect(JSON.stringify(buildInvoice(input))).toBe(JSON.stringify(buildInvoice(input)));
  });
});
