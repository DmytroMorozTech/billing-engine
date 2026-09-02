import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { anniversary, contains, daysInPeriod, periodContaining } from './billing-cycle.js';

/**
 * Any date in a twenty-year window, generated as year/month/day so that every
 * month length and both leap-year cases are reachable.
 */
const plainDate = fc
  .record({
    year: fc.integer({ min: 2020, max: 2040 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, day }) =>
    Temporal.PlainDate.from(
      { year, month, day },
      // Clamp rather than reject, so 31 February becomes 28/29 February and the
      // generator never throws.
      { overflow: 'constrain' },
    ),
  );

const monthOffset = fc.integer({ min: -240, max: 240 });

/**
 * The bug this file exists for: `periodContaining` once returned a period that
 * did not contain the date it was asked about, whenever that date landed
 * exactly on a clamped anniversary such as 28 February for a 31 January anchor.
 * A single example caught it by luck. This catches the whole class.
 */
describe('periodContaining always contains the date', () => {
  it('holds for any anchor and any date', () => {
    fc.assert(
      fc.property(plainDate, plainDate, (anchor, on) => {
        expect(contains(periodContaining(anchor, on), on)).toBe(true);
      }),
    );
  });

  it('holds on every anniversary boundary, where clamping bites', () => {
    fc.assert(
      fc.property(plainDate, monthOffset, (anchor, offset) => {
        const boundary = anniversary(anchor, offset);
        const period = periodContaining(anchor, boundary);

        expect(contains(period, boundary)).toBe(true);
        expect(period.start.equals(boundary)).toBe(true);
      }),
    );
  });
});

describe('periods tile the timeline', () => {
  it('consecutive periods meet exactly, with no gap and no overlap', () => {
    fc.assert(
      fc.property(plainDate, monthOffset, (anchor, offset) => {
        const period = periodContaining(anchor, anniversary(anchor, offset));
        const next = periodContaining(anchor, period.end);

        expect(next.start.equals(period.end)).toBe(true);
      }),
    );
  });

  it('a period is always at least 28 days and at most 31', () => {
    fc.assert(
      fc.property(plainDate, monthOffset, (anchor, offset) => {
        const period = periodContaining(anchor, anniversary(anchor, offset));
        const length = daysInPeriod(period);

        expect(length).toBeGreaterThanOrEqual(28);
        expect(length).toBeLessThanOrEqual(31);
      }),
    );
  });
});

describe('anniversaries never drift', () => {
  it('every anniversary keeps the anchor day, or the last day of a shorter month', () => {
    fc.assert(
      fc.property(plainDate, monthOffset, (anchor, offset) => {
        const result = anniversary(anchor, offset);
        const lastDayOfThatMonth = result.toPlainYearMonth().daysInMonth;

        expect(result.day === anchor.day || result.day === lastDayOfThatMonth).toBe(true);
        expect(result.day).toBeLessThanOrEqual(anchor.day);
      }),
    );
  });

  it('is reversible: going forward n months and back n months returns the anchor, unless clamped', () => {
    fc.assert(
      fc.property(plainDate, monthOffset, (anchor, offset) => {
        const forward = anniversary(anchor, offset);
        const back = anniversary(forward, -offset);

        // Clamping is lossy in one direction only: 31 Jan → 28 Feb → 28 Jan.
        // What must hold is that we never overshoot past the anchor.
        expect(Temporal.PlainDate.compare(back, anchor)).toBeLessThanOrEqual(0);
      }),
    );
  });
});
