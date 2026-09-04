import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { money } from '../money/money.js';
import { prepareCorrection } from './correction.js';
import { buildInvoice, type RatedTransaction } from './invoice-draft.js';
import { CHANNELS, type RateInterval } from './rate-interval.js';

const PERIOD = {
  start: Temporal.PlainDate.from('2026-09-01'),
  end: Temporal.PlainDate.from('2026-10-01'),
};

const eur = (amount: number) => money(amount, 'EUR');

const transactionArb = fc.record({
  id: fc.uuid(),
  amountMinor: fc.integer({ min: 1, max: 5_000_000 }),
  day: fc.integer({ min: 1, max: 30 }),
  channel: fc.constantFrom(...CHANNELS),
});

function intervalsFor(day: number): RateInterval[] {
  const change = PERIOD.start.add({ days: day - 1 });
  return [
    {
      id: 'ri_standard',
      planId: 'standard',
      monthlyFee: eur(0),
      rates: { in_person: 169, online: 250, moto: 295 },
      motoFixedFee: eur(25),
      effectiveFrom: Temporal.PlainDate.from('2026-01-31'),
      effectiveTo: change,
    },
    {
      id: 'ri_plus',
      planId: 'payments_plus',
      monthlyFee: eur(1900),
      rates: { in_person: 99, online: 250, moto: 295 },
      motoFixedFee: eur(25),
      effectiveFrom: change,
      effectiveTo: null,
    },
  ];
}

function invoiceFor(day: number, raw: readonly { id: string; amountMinor: number; day: number; channel: (typeof CHANNELS)[number] }[]) {
  const transactions: RatedTransaction[] = raw.map((t) => ({
    id: t.id,
    gross: eur(t.amountMinor),
    channel: t.channel,
    occurredOn: PERIOD.start.add({ days: t.day - 1 }),
  }));

  return buildInvoice({
    period: PERIOD,
    currency: 'EUR',
    intervals: intervalsFor(day),
    transactions,
    vat: { kind: 'standard', rateBps: 1900 },
  });
}

/**
 * The property the roadmap asks for: a credit never gives back more than was
 * charged.
 *
 * It is generated over where the upgrade originally fell and where it is moved
 * to, because that pair is what a support engineer actually changes when they
 * correct a merchant's timeline — and the interesting cases are the ones nobody
 * would think to write by hand: the change moved to the first day of the
 * period, or to the day it already sat on, or with all the volume on one side
 * of it.
 */
describe('a correction never returns more than was invoiced', () => {
  it('credits at most the invoiced total, and exactly the difference', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(transactionArb, { maxLength: 12 }),
        (originalDay, correctedDay, raw) => {
          const issued = invoiceFor(originalDay, raw);
          const recomputed = invoiceFor(correctedDay, raw);

          const correction = prepareCorrection({ period: PERIOD, issued, recomputed });

          if (correction.kind === 'none') {
            expect(recomputed.total).toEqual(issued.total);
            return;
          }

          if (correction.kind === 'undercharge') {
            // The other direction: the period turned out dearer. Never dressed
            // up as a credit, and always a positive shortfall.
            expect(correction.shortfall.amount).toBeGreaterThan(0);
            expect(recomputed.total.amount).toBeGreaterThan(issued.total.amount);
            return;
          }

          const credited = -correction.draft.total.amount;

          // Never more than was charged — the invariant this test exists for.
          expect(credited).toBeLessThanOrEqual(issued.total.amount);
          expect(credited).toBeGreaterThan(0);

          // And exactly what closes the gap: what stays charged is what the
          // recomputed period comes to.
          expect(issued.total.amount - credited).toBe(recomputed.total.amount);

          // The parts agree with the whole, so VAT is credited in proportion
          // rather than being left on an invoice that no longer justifies it.
          expect(correction.draft.subtotal.amount + correction.draft.vat.amount).toBe(
            correction.draft.total.amount,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never credits anything when the timeline did not move', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 30 }), fc.array(transactionArb, { maxLength: 12 }), (day, raw) => {
        const invoice = invoiceFor(day, raw);

        expect(prepareCorrection({ period: PERIOD, issued: invoice, recomputed: invoice })).toEqual({
          kind: 'none',
        });
      }),
    );
  });
});
