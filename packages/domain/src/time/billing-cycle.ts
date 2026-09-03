import { Temporal } from 'temporal-polyfill';

import type { Clock } from './clock.js';

/**
 * A billing period: half-open `[start, end)` in the merchant's own time zone.
 *
 * Half-open so that consecutive periods tile without overlap — a transaction at
 * midnight on the boundary belongs to exactly one of them.
 */
export interface BillingPeriod {
  readonly start: Temporal.PlainDate;
  readonly end: Temporal.PlainDate;
}

/**
 * The n-th monthly anniversary of an anchor date.
 *
 * The anchor is the *original* subscription date and it never moves. This is
 * the whole point: a subscription anchored on 31 January bills on 28 February
 * and then on **31 March**, not 28 March. Carrying the last actual charge
 * forward instead would make the subscription drift earlier every February and
 * quietly undercharge the merchant for the rest of its life.
 *
 * `Temporal.PlainYearMonth.daysInMonth` does the clamping; there is no manual
 * month-length table anywhere.
 */
export function anniversary(anchor: Temporal.PlainDate, monthsLater: number): Temporal.PlainDate {
  if (!Number.isSafeInteger(monthsLater)) {
    throw new RangeError('monthsLater must be an integer');
  }

  const targetMonth = anchor.toPlainYearMonth().add({ months: monthsLater });
  const day = Math.min(anchor.day, targetMonth.daysInMonth);

  return targetMonth.toPlainDate({ day });
}

/**
 * The monthly billing period containing `on`, for a subscription anchored on
 * `anchor`.
 */
export function periodContaining(
  anchor: Temporal.PlainDate,
  on: Temporal.PlainDate,
): BillingPeriod {
  // Deliberately not derived from `anchor.until(on, { largestUnit: 'month' })`.
  // That difference is measured in real calendar months, but the anniversaries
  // are clamped — from 31 January, the one-month anniversary is 28 February,
  // which `until` reports as 0 months and 28 days. Using it puts a date exactly
  // on a clamped boundary into the *previous* period, which then does not
  // contain the date that was asked about.
  //
  // Instead: start from the year-month distance as a cheap estimate, then walk
  // to the largest index whose anniversary is still on or before `on`. The
  // clamping can only ever be off by one, so each loop runs at most once.
  let index = fullMonthsBetween(anchor, on);

  while (Temporal.PlainDate.compare(anniversary(anchor, index), on) > 0) {
    index -= 1;
  }
  while (Temporal.PlainDate.compare(anniversary(anchor, index + 1), on) <= 0) {
    index += 1;
  }

  return { start: anniversary(anchor, index), end: anniversary(anchor, index + 1) };
}

/** Whole calendar days in a period. Never milliseconds — DST makes days uneven. */
export function daysInPeriod(period: BillingPeriod): number {
  return period.start.until(period.end, { largestUnit: 'day' }).days;
}

/** Whole calendar days from `start` (inclusive) to `end` (exclusive). */
export function daysBetween(start: Temporal.PlainDate, end: Temporal.PlainDate): number {
  return start.until(end, { largestUnit: 'day' }).days;
}

export function contains(period: BillingPeriod, date: Temporal.PlainDate): boolean {
  return (
    Temporal.PlainDate.compare(date, period.start) >= 0 &&
    Temporal.PlainDate.compare(date, period.end) < 0
  );
}

function fullMonthsBetween(anchor: Temporal.PlainDate, date: Temporal.PlainDate): number {
  return anchor.toPlainYearMonth().until(date.toPlainYearMonth(), { largestUnit: 'month' }).months;
}

/**
 * Today's date in a given time zone, from an injected clock.
 *
 * A merchant in Italy and one in the UK are in different calendar days at the
 * same instant, and the date on a tax invoice has legal meaning — so "today"
 * is never a property of the server. See ADR-0002.
 */
export function todayIn(clock: Clock, timeZone: string): Temporal.PlainDate {
  return clock.now().withTimeZone(timeZone).toPlainDate();
}

/** The billing period a subscription is currently in, in the merchant's zone. */
export function currentPeriod(
  anchor: Temporal.PlainDate,
  clock: Clock,
  timeZone: string,
): BillingPeriod {
  return periodContaining(anchor, todayIn(clock, timeZone));
}
