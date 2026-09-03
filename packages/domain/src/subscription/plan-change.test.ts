import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { money } from '../money/money.js';
import { buildInvoice } from '../rating/invoice-draft.js';
import type { RateInterval, RateTerms } from '../rating/rate-interval.js';
import { PlanChangeError, preparePlanChange } from './plan-change.js';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

const STANDARD: RateTerms = {
  planId: 'standard',
  monthlyFee: eur(0),
  rates: { in_person: 169, online: 250, moto: 295 },
  motoFixedFee: eur(25),
};

const PLUS: RateTerms = {
  planId: 'payments_plus',
  monthlyFee: eur(1900),
  rates: { in_person: 99, online: 250, moto: 295 },
  motoFixedFee: eur(25),
};

const openStandard: RateInterval = {
  ...STANDARD,
  id: 'ri_1',
  effectiveFrom: date('2026-01-31'),
  effectiveTo: null,
};

function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

describe('prospective change', () => {
  const plan = preparePlanChange({
    currentIntervals: [openStandard],
    newTerms: PLUS,
    effectiveFrom: date('2026-09-15'),
    today: date('2026-09-15'),
    nextId: ids('new'),
  });

  it('is not treated as a correction', () => {
    expect(plan.backdated).toBe(false);
  });

  it('closes the open interval rather than superseding it', () => {
    // Nothing already invoiced moves, so there is no old version to preserve.
    expect(plan.closes).toEqual([{ id: 'ri_1', effectiveTo: date('2026-09-15') }]);
    expect(plan.supersedes).toEqual([]);
  });

  it('opens exactly one new interval', () => {
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      planId: 'payments_plus',
      effectiveFrom: date('2026-09-15'),
      effectiveTo: null,
    });
  });

  it('leaves a timeline that tiles without gaps or overlaps', () => {
    expect(plan.resulting.map((i) => [i.planId, i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null])).toEqual([
      ['standard', '2026-01-31', '2026-09-15'],
      ['payments_plus', '2026-09-15', null],
    ]);
  });
});

describe('future-dated change', () => {
  it('is prospective even though it has not happened yet', () => {
    const plan = preparePlanChange({
      currentIntervals: [openStandard],
      newTerms: PLUS,
      effectiveFrom: date('2026-10-01'),
      today: date('2026-09-15'),
      nextId: ids('new'),
    });

    expect(plan.backdated).toBe(false);
    expect(plan.closes).toHaveLength(1);
  });

  it('supersedes an already-scheduled change that this one replaces', () => {
    const scheduled: RateInterval = {
      ...PLUS,
      id: 'ri_2',
      effectiveFrom: date('2026-10-01'),
      effectiveTo: null,
    };
    const closedStandard: RateInterval = { ...openStandard, effectiveTo: date('2026-10-01') };

    const plan = preparePlanChange({
      currentIntervals: [closedStandard, scheduled],
      newTerms: { ...PLUS, planId: 'enterprise', monthlyFee: eur(9900) },
      effectiveFrom: date('2026-10-01'),
      today: date('2026-09-15'),
      nextId: ids('new'),
    });

    // The scheduled Plus interval starts exactly where the new one does, so it
    // is replaced outright rather than shortened to nothing.
    expect(plan.supersedes).toEqual([{ id: 'ri_2', supersededBy: 'new_1' }]);
    expect(plan.closes).toEqual([]);
    expect(plan.resulting.map((i) => i.planId)).toEqual(['standard', 'enterprise']);
  });
});

/**
 * The case the database integration test forced into the open: a backdated
 * change does not replace one row with one row. It supersedes every interval it
 * touches and lays down a new timeline beside the old one.
 */
describe('backdated change', () => {
  const plan = preparePlanChange({
    currentIntervals: [
      { ...openStandard, effectiveTo: date('2026-09-15') },
      { ...PLUS, id: 'ri_2', effectiveFrom: date('2026-09-15'), effectiveTo: null },
    ],
    newTerms: PLUS,
    effectiveFrom: date('2026-09-05'),
    today: date('2026-09-20'),
    nextId: ids('fix'),
  });

  it('is flagged as reaching into the past', () => {
    expect(plan.backdated).toBe(true);
  });

  it('supersedes both the shortened interval and the one it replaces', () => {
    expect(plan.supersedes).toEqual([
      { id: 'ri_1', supersededBy: 'fix_2' },
      { id: 'ri_2', supersededBy: 'fix_1' },
    ]);
    // Nothing is closed in place: every affected version is preserved.
    expect(plan.closes).toEqual([]);
  });

  it('inserts a shortened replacement and the corrected interval', () => {
    expect(
      plan.inserts.map((i) => [i.planId, i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null]),
    ).toEqual([
      ['standard', '2026-01-31', '2026-09-05'],
      ['payments_plus', '2026-09-05', null],
    ]);
  });

  it('produces a timeline that still tiles', () => {
    expect(
      plan.resulting.map((i) => [i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null]),
    ).toEqual([
      ['2026-01-31', '2026-09-05'],
      ['2026-09-05', null],
    ]);
  });

  it('changes the invoice, which is the whole reason history is kept', () => {
    const period = { start: date('2026-09-01'), end: date('2026-10-01') };
    const transactions = [
      { id: 't1', gross: eur(413_000), channel: 'in_person' as const, occurredOn: date('2026-09-10') },
      { id: 't2', gross: eur(387_000), channel: 'in_person' as const, occurredOn: date('2026-09-20') },
    ];

    const before = buildInvoice({
      period,
      currency: 'EUR',
      intervals: [
        { ...openStandard, effectiveTo: date('2026-09-15') },
        { ...PLUS, id: 'ri_2', effectiveFrom: date('2026-09-15'), effectiveTo: null },
      ],
      transactions,
      vat: { kind: 'standard' as const, rateBps: 1900 },
    });

    const after = buildInvoice({
      period,
      currency: 'EUR',
      intervals: plan.resulting,
      transactions,
      vat: { kind: 'standard' as const, rateBps: 1900 },
    });

    // Before: the upgrade lands on the 15th, so the 10 September volume is
    // charged at 1.69% and only 16 of 30 days of the fee are due.
    expect(before.lines.map((l) => l.amount.amount)).toEqual([1013, 6980, 3831]);
    expect(before.total.amount).toBe(14_071);

    // After: the upgrade actually happened on the 5th. Both transactions now
    // fall in the Plus segment, so they merge into one line at 0.99% —
    // 800000 × 99 ÷ 10000 = 7920 — and 26 of 30 days of the fee are due:
    // 1900 × 26 ÷ 30 = 1646.67 → 1647. Subtotal 9567, VAT 1817.73 → 1818.
    expect(after.lines.map((l) => l.amount.amount)).toEqual([1647, 7920]);
    expect(after.subtotal.amount).toBe(9567);
    expect(after.vat.amount).toBe(1818);
    expect(after.total.amount).toBe(11_385);

    // The merchant is better off, which is the point of correcting the record —
    // and the difference is exactly what a credit note has to cover.
    expect(before.total.amount - after.total.amount).toBe(2686);
  });
});

describe('change effective exactly where the current interval starts', () => {
  it('replaces it rather than leaving a zero-length interval', () => {
    const plan = preparePlanChange({
      currentIntervals: [
        { ...openStandard, effectiveTo: date('2026-09-15') },
        { ...PLUS, id: 'ri_2', effectiveFrom: date('2026-09-15'), effectiveTo: null },
      ],
      newTerms: { ...STANDARD, planId: 'standard' },
      effectiveFrom: date('2026-09-15'),
      today: date('2026-09-15'),
      nextId: ids('new'),
    });

    // A zero-length interval violates the schema's CHECK and means nothing.
    expect(plan.inserts).toHaveLength(1);
    expect(plan.supersedes).toEqual([{ id: 'ri_2', supersededBy: 'new_1' }]);
    expect(plan.resulting).toHaveLength(2);
  });
});

describe('rejections', () => {
  it('refuses a change to the plan already in force', () => {
    expect(() =>
      preparePlanChange({
        currentIntervals: [openStandard],
        newTerms: STANDARD,
        effectiveFrom: date('2026-09-15'),
        today: date('2026-09-15'),
        nextId: ids('new'),
      }),
    ).toThrow(PlanChangeError);
  });

  it('refuses a date before the subscription existed', () => {
    expect(() =>
      preparePlanChange({
        currentIntervals: [openStandard],
        newTerms: PLUS,
        effectiveFrom: date('2025-06-01'),
        today: date('2026-09-15'),
        nextId: ids('new'),
      }),
    ).toThrow(/before the subscription started/);
  });

  it('refuses when there are no intervals at all', () => {
    expect(() =>
      preparePlanChange({
        currentIntervals: [],
        newTerms: PLUS,
        effectiveFrom: date('2026-09-15'),
        today: date('2026-09-15'),
        nextId: ids('new'),
      }),
    ).toThrow(PlanChangeError);
  });

  it('refuses a date that falls in a gap between intervals', () => {
    expect(() =>
      preparePlanChange({
        currentIntervals: [{ ...openStandard, effectiveTo: date('2026-09-01') }],
        newTerms: PLUS,
        effectiveFrom: date('2026-09-15'),
        today: date('2026-09-15'),
        nextId: ids('new'),
      }),
    ).toThrow(/No rate is in force/);
  });
});
