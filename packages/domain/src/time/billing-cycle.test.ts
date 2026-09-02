import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { anniversary, contains, daysBetween, daysInPeriod, periodContaining } from './billing-cycle.js';
import { VirtualClock } from './clock.js';

const date = (iso: string) => Temporal.PlainDate.from(iso);

/**
 * The anniversary problem. A subscription anchored on 31 January must bill on
 * 28 February and then on 31 March. Systems that carry the last actual charge
 * forward produce 28 March instead, and the subscription drifts earlier every
 * year — quietly undercharging for the rest of its life.
 */
describe('anniversary keeps the original anchor', () => {
  const anchor = date('2026-01-31');

  it('clamps into a short month without losing the anchor day', () => {
    expect(anniversary(anchor, 1).toString()).toBe('2026-02-28');
    expect(anniversary(anchor, 2).toString()).toBe('2026-03-31');
    expect(anniversary(anchor, 3).toString()).toBe('2026-04-30');
    expect(anniversary(anchor, 4).toString()).toBe('2026-05-31');
  });

  it('handles February in a leap year', () => {
    expect(anniversary(date('2028-01-31'), 1).toString()).toBe('2028-02-29');
    expect(anniversary(date('2028-01-29'), 1).toString()).toBe('2028-02-29');
    expect(anniversary(date('2027-01-29'), 1).toString()).toBe('2027-02-28');
  });

  it('rolls over year boundaries', () => {
    expect(anniversary(date('2026-11-30'), 3).toString()).toBe('2027-02-28');
    expect(anniversary(anchor, 12).toString()).toBe('2027-01-31');
  });

  it('walks backwards too, which a backdated change needs', () => {
    expect(anniversary(date('2026-03-31'), -1).toString()).toBe('2026-02-28');
  });

  it('never drifts, however many cycles are applied', () => {
    const days = Array.from({ length: 36 }, (_, i) => anniversary(anchor, i + 1).day);
    // Every cycle is either the 31st, or the last day of a shorter month.
    expect(days.filter((d) => d === 31)).toHaveLength(21);
    expect(anniversary(anchor, 36).toString()).toBe('2029-01-31');
  });
});

describe('periodContaining', () => {
  const anchor = date('2026-01-31');

  it('finds the cycle a date falls into', () => {
    const period = periodContaining(anchor, date('2026-03-15'));
    expect(period.start.toString()).toBe('2026-02-28');
    expect(period.end.toString()).toBe('2026-03-31');
  });

  it('treats the period as half-open, so cycles tile without overlap', () => {
    const period = periodContaining(anchor, date('2026-02-28'));
    expect(contains(period, date('2026-02-28'))).toBe(true);
    expect(contains(period, date('2026-03-31'))).toBe(false);

    const next = periodContaining(anchor, date('2026-03-31'));
    expect(next.start.toString()).toBe('2026-03-31');
  });

  it('returns the anchor period on the anchor date itself', () => {
    const period = periodContaining(anchor, anchor);
    expect(period.start.toString()).toBe('2026-01-31');
    expect(period.end.toString()).toBe('2026-02-28');
  });
});

describe('day counting is calendar-based', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween(date('2026-09-01'), date('2026-10-01'))).toBe(30);
    expect(daysBetween(date('2026-02-01'), date('2026-03-01'))).toBe(28);
    expect(daysBetween(date('2028-02-01'), date('2028-03-01'))).toBe(29);
  });

  it('measures a period', () => {
    expect(daysInPeriod({ start: date('2026-09-15'), end: date('2026-10-01') })).toBe(16);
  });
});

/**
 * A "day" is not 24 hours twice a year. Adding calendar days rather than
 * milliseconds is what keeps a proration from shifting by 1/24th of a day.
 */
describe('daylight saving time', () => {
  it('a spring-forward day is 23 hours long, and adding a day still lands on the next date', () => {
    // Europe/Berlin moves to summer time on 2026-03-29.
    const clock = VirtualClock.at('2026-03-28T12:00:00+01:00[Europe/Berlin]');
    const before = clock.now();
    const after = clock.advance({ days: 1 }).now();

    expect(after.toPlainDate().toString()).toBe('2026-03-29');
    expect(before.until(after, { largestUnit: 'hour' }).hours).toBe(23);
  });

  it('an autumn-back day is 25 hours long', () => {
    // Europe/Berlin returns to winter time on 2026-10-25.
    const clock = VirtualClock.at('2026-10-24T12:00:00+02:00[Europe/Berlin]');
    const before = clock.now();
    const after = clock.advance({ days: 1 }).now();

    expect(after.toPlainDate().toString()).toBe('2026-10-25');
    expect(before.until(after, { largestUnit: 'hour' }).hours).toBe(25);
  });
});

/**
 * The same instant is a different calendar day depending on the merchant's
 * billing time zone. The date on a tax invoice has legal meaning, so this is
 * not a display concern.
 */
describe('merchants in different time zones are in different days', () => {
  it('splits an instant across a date boundary', () => {
    const instant = Temporal.Instant.from('2026-09-30T23:30:00Z');

    const london = instant.toZonedDateTimeISO('Europe/London').toPlainDate();
    const rome = instant.toZonedDateTimeISO('Europe/Rome').toPlainDate();

    expect(london.toString()).toBe('2026-10-01');
    expect(rome.toString()).toBe('2026-10-01');

    const earlier = Temporal.Instant.from('2026-09-30T22:30:00Z');
    expect(earlier.toZonedDateTimeISO('Europe/London').toPlainDate().toString()).toBe('2026-09-30');
    expect(earlier.toZonedDateTimeISO('Europe/Rome').toPlainDate().toString()).toBe('2026-10-01');
  });
});
