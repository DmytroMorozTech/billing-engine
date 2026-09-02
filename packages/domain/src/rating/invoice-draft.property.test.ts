import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { add, applyRate, money, sum, zero } from '../money/money.js';
import { daysInPeriod } from '../time/billing-cycle.js';
import { buildInvoice, type RatedTransaction } from './invoice-draft.js';
import { CHANNELS, type RateInterval, segmentPeriod } from './rate-interval.js';

const PERIOD = { start: Temporal.PlainDate.from('2026-09-01'), end: Temporal.PlainDate.from('2026-10-01') };
const PERIOD_DAYS = daysInPeriod(PERIOD);

/** The day within September on which the merchant changes plan. */
const changeDay = fc.integer({ min: 2, max: 30 });

interface RawTransaction {
  id: string;
  amountMinor: number;
  day: number;
  channel: (typeof CHANNELS)[number];
}

const transactionArb: fc.Arbitrary<RawTransaction> = fc.record({
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
      monthlyFee: money(0, 'EUR'),
      rates: { in_person: 169, online: 250, moto: 295 },
      motoFixedFee: money(25, 'EUR'),
      effectiveFrom: Temporal.PlainDate.from('2026-01-31'),
      effectiveTo: change,
    },
    {
      id: 'ri_plus',
      planId: 'payments_plus',
      monthlyFee: money(1900, 'EUR'),
      rates: { in_person: 99, online: 250, moto: 295 },
      motoFixedFee: money(25, 'EUR'),
      effectiveFrom: change,
      effectiveTo: null,
    },
  ];
}

function toTransactions(raw: readonly RawTransaction[]): RatedTransaction[] {
  return raw.map((t) => ({
    id: t.id,
    gross: money(t.amountMinor, 'EUR'),
    channel: t.channel,
    occurredOn: PERIOD.start.add({ days: t.day - 1 }),
  }));
}

describe('segmentation loses no days', () => {
  it('segments tile the period exactly, wherever the change falls', () => {
    fc.assert(
      fc.property(changeDay, (day) => {
        const segments = segmentPeriod(PERIOD, intervalsFor(day));
        const covered = segments.reduce((total, segment) => total + segment.days, 0);

        expect(covered).toBe(PERIOD_DAYS);
        // Each segment starts exactly where the previous ended.
        for (let i = 1; i < segments.length; i += 1) {
          expect(segments[i]?.from.equals(segments[i - 1]!.to)).toBe(true);
        }
      }),
    );
  });
});

describe('every transaction is priced exactly once', () => {
  it('total commission equals the sum of each transaction priced by its own segment', () => {
    fc.assert(
      fc.property(changeDay, fc.array(transactionArb, { maxLength: 40 }), (day, raw) => {
        const intervals = intervalsFor(day);
        const transactions = toTransactions(raw);
        const segments = segmentPeriod(PERIOD, intervals);

        const invoice = buildInvoice({
          period: PERIOD,
          currency: 'EUR',
          intervals,
          transactions,
          vatRateBps: 1900,
        });

        const charged = invoice.lines
          .filter((line) => line.kind === 'commission')
          .reduce((total, line) => total + line.amount.amount, 0);

        // Recompute independently: group by (segment, channel), which is the
        // grouping rounding is applied at, then sum. Anything double-counted or
        // dropped shows up here.
        let expected = 0;
        for (const segment of segments) {
          for (const channel of CHANNELS) {
            const matching = transactions.filter(
              (t) =>
                t.channel === channel &&
                Temporal.PlainDate.compare(t.occurredOn, segment.from) >= 0 &&
                Temporal.PlainDate.compare(t.occurredOn, segment.to) < 0,
            );
            if (matching.length === 0) continue;

            const volume = sum(
              matching.map((t) => t.gross),
              'EUR',
            );
            expected += applyRate(volume, segment.interval.rates[channel]).amount;
            if (channel === 'moto') {
              expected += segment.interval.motoFixedFee.amount * matching.length;
            }
          }
        }

        expect(charged).toBe(expected);
      }),
    );
  });
});

describe('invoice totals are internally consistent', () => {
  it('total is always subtotal plus VAT, and subtotal is always the sum of lines', () => {
    fc.assert(
      fc.property(changeDay, fc.array(transactionArb, { maxLength: 30 }), (day, raw) => {
        const invoice = buildInvoice({
          period: PERIOD,
          currency: 'EUR',
          intervals: intervalsFor(day),
          transactions: toTransactions(raw),
          vatRateBps: 1900,
        });

        const lineSum = invoice.lines.reduce(
          (total, line) => add(total, line.amount),
          zero('EUR'),
        );

        expect(invoice.subtotal).toEqual(lineSum);
        expect(invoice.total).toEqual(add(invoice.subtotal, invoice.vat));
        expect(invoice.vat).toEqual(applyRate(invoice.subtotal, 1900));
      }),
    );
  });
});

describe('the prorated subscription fee never exceeds the full fee', () => {
  it('holds wherever the change falls', () => {
    fc.assert(
      fc.property(changeDay, (day) => {
        const invoice = buildInvoice({
          period: PERIOD,
          currency: 'EUR',
          intervals: intervalsFor(day),
          transactions: [],
          vatRateBps: 1900,
        });

        const subscription = invoice.lines
          .filter((line) => line.kind === 'subscription')
          .reduce((total, line) => total + line.amount.amount, 0);

        // A merchant on Plus for part of a month cannot be charged more than a
        // merchant on Plus for all of it.
        expect(subscription).toBeGreaterThanOrEqual(0);
        expect(subscription).toBeLessThanOrEqual(1900);
      }),
    );
  });
});

describe('every line carries an explanation', () => {
  it('no line is ever produced without a derivation naming its result', () => {
    fc.assert(
      fc.property(changeDay, fc.array(transactionArb, { maxLength: 20 }), (day, raw) => {
        const invoice = buildInvoice({
          period: PERIOD,
          currency: 'EUR',
          intervals: intervalsFor(day),
          transactions: toTransactions(raw),
          vatRateBps: 1900,
        });

        for (const line of invoice.lines) {
          expect(line.derivation.result).toEqual(line.amount);
          expect(line.derivation.formula).not.toBe('');
          expect(line.derivation.inputs.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
