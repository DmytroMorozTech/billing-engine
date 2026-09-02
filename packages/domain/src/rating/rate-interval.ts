import { Temporal } from 'temporal-polyfill';

import type { BasisPoints, Money } from '../money/money.js';
import { type BillingPeriod, daysBetween } from '../time/billing-cycle.js';

export type Channel = 'in_person' | 'online' | 'moto';

export const CHANNELS: readonly Channel[] = ['in_person', 'online', 'moto'];

/** What a plan costs. Copied onto an interval, never joined from the catalogue. */
export interface RateTerms {
  planId: string;
  monthlyFee: Money;
  rates: Readonly<Record<Channel, BasisPoints>>;
  /** MOTO is a percentage plus a flat fee, so not every channel is a pure rate. */
  motoFixedFee: Money;
}

export interface RateInterval extends RateTerms {
  id: string;
  /** Inclusive, in the merchant's billing time zone. */
  effectiveFrom: Temporal.PlainDate;
  /** Exclusive. `null` means still open. */
  effectiveTo: Temporal.PlainDate | null;
}

/** A rate interval clipped to the billing period being invoiced. */
export interface RateSegment {
  interval: RateInterval;
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
  days: number;
}

export class RateCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateCoverageError';
  }
}

/**
 * Cuts a billing period into the rate segments that cover it.
 *
 * A merchant who upgrades on the 15th of a 30-day period produces two segments:
 * 14 days on the old terms and 16 on the new. Each is then priced separately,
 * because the rate in force when a transaction happened is the rate that
 * applies to it (ADR-0006).
 *
 * Throws rather than guessing if the intervals do not cover the period. A gap
 * means the subscription timeline is broken, and inventing a rate to fill it
 * would turn a data problem into a silently wrong invoice.
 */
export function segmentPeriod(
  period: BillingPeriod,
  intervals: readonly RateInterval[],
): RateSegment[] {
  const overlapping = intervals
    .filter((interval) => overlaps(interval, period))
    .sort((a, b) => Temporal.PlainDate.compare(a.effectiveFrom, b.effectiveFrom));

  if (overlapping.length === 0) {
    throw new RateCoverageError(
      `No rate interval covers ${period.start.toString()}..${period.end.toString()}`,
    );
  }

  const segments: RateSegment[] = [];
  let cursor = period.start;

  for (const interval of overlapping) {
    const from = laterOf(interval.effectiveFrom, period.start);
    const to = earlierOf(interval.effectiveTo ?? period.end, period.end);

    if (Temporal.PlainDate.compare(from, cursor) > 0) {
      throw new RateCoverageError(
        `No rate in force from ${cursor.toString()} to ${from.toString()}`,
      );
    }
    // The database forbids overlapping current intervals, so a segment that
    // starts before the cursor can only mean stale data was passed in.
    if (Temporal.PlainDate.compare(from, cursor) < 0) {
      throw new RateCoverageError(
        `Rate intervals overlap at ${from.toString()}; expected them to be disjoint`,
      );
    }
    if (Temporal.PlainDate.compare(to, from) <= 0) {
      continue;
    }

    segments.push({ interval, from, to, days: daysBetween(from, to) });
    cursor = to;
  }

  if (Temporal.PlainDate.compare(cursor, period.end) !== 0) {
    throw new RateCoverageError(
      `No rate in force from ${cursor.toString()} to ${period.end.toString()}`,
    );
  }

  return segments;
}

export function segmentContaining(
  segments: readonly RateSegment[],
  date: Temporal.PlainDate,
): RateSegment | undefined {
  return segments.find(
    (segment) =>
      Temporal.PlainDate.compare(date, segment.from) >= 0 &&
      Temporal.PlainDate.compare(date, segment.to) < 0,
  );
}

function overlaps(interval: RateInterval, period: BillingPeriod): boolean {
  const endsAfterPeriodStarts =
    interval.effectiveTo === null ||
    Temporal.PlainDate.compare(interval.effectiveTo, period.start) > 0;
  const startsBeforePeriodEnds =
    Temporal.PlainDate.compare(interval.effectiveFrom, period.end) < 0;

  return endsAfterPeriodStarts && startsBeforePeriodEnds;
}

function laterOf(a: Temporal.PlainDate, b: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(a, b) >= 0 ? a : b;
}

function earlierOf(a: Temporal.PlainDate, b: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(a, b) <= 0 ? a : b;
}
