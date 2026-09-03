import type { Temporal } from 'temporal-polyfill';

import type { CurrencyCode } from '../money/currency.js';
import {
  type BasisPoints,
  type Money,
  add,
  applyRate,
  applyRateExact,
  multiply,
  prorate,
  prorateExact,
  sum,
  toDecimalString,
  zero,
} from '../money/money.js';
import type { VatTreatment } from '../tax/vat.js';
import { type BillingPeriod, daysInPeriod } from '../time/billing-cycle.js';
import { type Derivation, computation, rounded, value } from './derivation.js';
import {
  CHANNELS,
  type Channel,
  type RateSegment,
  segmentPeriod,
  type RateInterval,
} from './rate-interval.js';

export interface RatedTransaction {
  id: string;
  gross: Money;
  channel: Channel;
  /** Local date in the merchant's billing time zone, frozen at ingest. */
  occurredOn: Temporal.PlainDate;
}

export type LineKind = 'subscription' | 'commission' | 'proration_credit' | 'adjustment';

export interface InvoiceLineDraft {
  kind: LineKind;
  description: string;
  amount: Money;
  vatRateBps: BasisPoints;
  derivation: Derivation;
}

export interface InvoiceDraft {
  period: BillingPeriod;
  currency: CurrencyCode;
  lines: InvoiceLineDraft[];
  subtotal: Money;
  vat: Money;
  total: Money;
  /**
   * Why the VAT is what it is. Two treatments come to zero for different
   * reasons, and an invoice showing no VAT has to say which one applied.
   */
  vatTreatment: VatTreatment['kind'];
}

export interface BuildInvoiceInput {
  period: BillingPeriod;
  currency: CurrencyCode;
  intervals: readonly RateInterval[];
  transactions: readonly RatedTransaction[];
  /** The treatment carries its own rate, so the two cannot disagree. */
  vat: VatTreatment;
}

/**
 * Builds the draft invoice for one billing period.
 *
 * Pure: no clock, no database, no ids. Everything that varies is an argument,
 * which is what makes the whole calculation reproducible — recomputing a closed
 * period has to be byte-identical, and it cannot be if the function can reach
 * for the current time.
 *
 * Rounding happens per line and the lines are then summed, per ADR-0001. VAT is
 * applied to the subtotal, not to each line, because that is what an invoice
 * shows and what the tax authority expects to be able to check.
 */
export function buildInvoice(input: BuildInvoiceInput): InvoiceDraft {
  const { period, currency, intervals, transactions, vat: treatment } = input;

  // One rate, taken from the treatment rather than passed beside it: an
  // invoice that says "reverse charge" and carries 19% on its lines is a state
  // worth making unrepresentable.
  const vatRateBps = treatment.rateBps;

  const segments = segmentPeriod(period, intervals);
  const periodDays = daysInPeriod(period);

  const lines: InvoiceLineDraft[] = [
    ...subscriptionLines(segments, period, periodDays, vatRateBps),
    ...commissionLines(segments, transactions, currency, vatRateBps),
  ];

  const subtotal = sum(
    lines.map((line) => line.amount),
    currency,
  );
  const vat = applyRate(subtotal, vatRateBps);

  return {
    period,
    currency,
    lines,
    subtotal,
    vat,
    total: add(subtotal, vat),
    vatTreatment: treatment.kind,
  };
}

/**
 * One prorated subscription line per segment.
 *
 * A segment whose plan is free contributes nothing — €0 prorated is still €0 —
 * so the line is omitted. The segment itself still exists and is still what
 * explains the commission rate that applied during it.
 */
function subscriptionLines(
  segments: readonly RateSegment[],
  period: BillingPeriod,
  periodDays: number,
  vatRateBps: BasisPoints,
): InvoiceLineDraft[] {
  return segments.flatMap((segment) => {
    const { monthlyFee, planId } = segment.interval;
    if (monthlyFee.amount === 0) {
      return [];
    }

    const amount = prorate(monthlyFee, segment.days, periodDays);
    const exact = prorateExact(monthlyFee, segment.days, periodDays);

    return [
      {
        kind: 'subscription' as const,
        description: `Subscription — ${planId}, ${segment.from.toString()} to ${segment.to.toString()}`,
        amount,
        vatRateBps,
        derivation: {
          result: amount,
          formula: 'monthly fee × days in segment ÷ days in period',
          rounding: rounded(exact, amount.amount),
          inputs: [
            value('Monthly fee', monthlyFee),
            value('Days in segment', segment.days),
            value('Days in period', periodDays),
            value(
              'Period',
              `${period.start.toString()} to ${period.end.toString()}`,
            ),
          ],
        },
      },
    ];
  });
}

/**
 * One commission line per segment and channel that saw volume.
 *
 * Splitting by segment is the point of ADR-0006: volume processed before an
 * upgrade keeps the old rate. Splitting by channel is because the rates differ
 * per channel, and MOTO additionally carries a flat fee per transaction.
 */
function commissionLines(
  segments: readonly RateSegment[],
  transactions: readonly RatedTransaction[],
  currency: CurrencyCode,
  vatRateBps: BasisPoints,
): InvoiceLineDraft[] {
  const lines: InvoiceLineDraft[] = [];

  for (const segment of segments) {
    for (const channel of CHANNELS) {
      const matching = transactions.filter(
        (transaction) =>
          transaction.channel === channel && withinSegment(transaction.occurredOn, segment),
      );
      if (matching.length === 0) {
        continue;
      }

      const volume = sum(
        matching.map((transaction) => transaction.gross),
        currency,
      );
      const rate = segment.interval.rates[channel];
      const percentage = applyRate(volume, rate);
      const exact = applyRateExact(volume, rate);

      const percentageDerivation: Derivation = {
        result: percentage,
        formula: 'volume × rate',
        rounding: rounded(exact, percentage.amount),
        inputs: [
          value(`Volume ${segment.from.toString()} to ${segment.to.toString()}`, volume),
          value('Rate', `${rate} bps = ${formatBps(rate)}%`),
          value('Plan', segment.interval.planId),
          value('Transactions', matching.length),
        ],
      };

      const fixed =
        channel === 'moto' && segment.interval.motoFixedFee.amount !== 0
          ? multiply(segment.interval.motoFixedFee, matching.length)
          : zero(currency);

      const amount = add(percentage, fixed);

      lines.push({
        kind: 'commission',
        description: `Commission — ${segment.interval.planId}, ${channelLabel(channel)}, ${segment.from.toString()} to ${segment.to.toString()}`,
        amount,
        vatRateBps,
        derivation:
          fixed.amount === 0
            ? percentageDerivation
            : {
                result: amount,
                formula: 'volume × rate + fixed fee × transactions',
                inputs: [
                  computation('Percentage component', percentageDerivation),
                  value('Fixed fee per transaction', segment.interval.motoFixedFee),
                  value('Transactions', matching.length),
                  value('Fixed component', fixed),
                ],
              },
      });
    }
  }

  return lines;
}

function withinSegment(date: Temporal.PlainDate, segment: RateSegment): boolean {
  return (
    date.since(segment.from).sign >= 0 && date.since(segment.to).sign < 0
  );
}

function formatBps(rate: BasisPoints): string {
  return toDecimalString({ amount: rate, currency: 'EUR' });
}

function channelLabel(channel: Channel): string {
  return channel === 'in_person' ? 'in person' : channel;
}
