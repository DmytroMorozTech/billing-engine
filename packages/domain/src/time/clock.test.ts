import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { type Clock, VirtualClock } from './clock.js';

describe('VirtualClock', () => {
  it('only moves when told to', () => {
    const clock = VirtualClock.at('2026-09-01T00:00:00+02:00[Europe/Berlin]');

    const first = clock.now();
    const second = clock.now();

    expect(first.equals(second)).toBe(true);
  });

  it('advances by calendar-aware durations', () => {
    const clock = VirtualClock.at('2026-01-31T00:00:00+01:00[Europe/Berlin]');

    clock.advance({ months: 1 });

    expect(clock.now().toPlainDate().toString()).toBe('2026-02-28');
  });

  it('can be set to an arbitrary instant, for reproducing a bug', () => {
    const clock = VirtualClock.at('2026-09-01T00:00:00+02:00[Europe/Berlin]');

    clock.setTo(Temporal.ZonedDateTime.from('2026-02-01T09:15:00+01:00[Europe/Berlin]'));

    expect(clock.now().toString()).toContain('2026-02-01T09:15:00');
  });

  it('fast-forwards a year one day at a time, deterministically', () => {
    const clock = VirtualClock.at('2026-01-01T00:00:00Z[UTC]');

    for (let i = 0; i < 365; i += 1) {
      clock.advance({ days: 1 });
    }

    expect(clock.now().toPlainDate().toString()).toBe('2027-01-01');
  });

  it('satisfies the Clock interface, so domain code cannot tell it apart', () => {
    const clock: Clock = VirtualClock.at('2026-09-01T00:00:00Z[UTC]');
    expect(clock.now()).toBeInstanceOf(Temporal.ZonedDateTime);
  });
});
