import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from './clock.js';
import {
  DeterministicScheduler,
  RunawaySchedulerError,
  type ScheduledJob,
} from './scheduler.js';

const at = (iso: string) => Temporal.ZonedDateTime.from(iso);
const START = '2026-09-01T00:00:00+02:00[Europe/Berlin]';

function job(id: string, runAt: string, kind = 'test', payload: unknown = null): ScheduledJob {
  return { id, kind, runAt: at(runAt), payload };
}

function setup(handler?: (job: ScheduledJob, clock: { now(): Temporal.ZonedDateTime }) => void) {
  const clock = VirtualClock.at(START);
  const seen: Array<{ id: string; ranAt: string }> = [];

  const scheduler = new DeterministicScheduler(clock, (j, c) => {
    seen.push({ id: j.id, ranAt: c.now().toString() });
    handler?.(j, c);
  });

  return { clock, scheduler, seen };
}

describe('running due work', () => {
  it('runs nothing until time moves', async () => {
    const { scheduler, seen } = setup();
    scheduler.schedule(job('a', '2026-09-10T09:00:00+02:00[Europe/Berlin]'));

    expect(seen).toEqual([]);
    expect(scheduler.pending()).toHaveLength(1);
  });

  it('runs jobs that fall due and leaves the rest pending', async () => {
    const { scheduler, seen } = setup();
    scheduler.schedule(job('soon', '2026-09-05T00:00:00+02:00[Europe/Berlin]'));
    scheduler.schedule(job('later', '2026-10-05T00:00:00+02:00[Europe/Berlin]'));

    const ran = await scheduler.advanceMonths(1);

    expect(ran.map((j) => j.id)).toEqual(['soon']);
    expect(seen.map((s) => s.id)).toEqual(['soon']);
    expect(scheduler.pending().map((j) => j.id)).toEqual(['later']);
  });

  it('runs a handler at the job’s own time, not the target', async () => {
    // A job that thinks it ran late would compute the wrong billing period.
    const { scheduler, seen } = setup();
    scheduler.schedule(job('a', '2026-09-05T09:30:00+02:00[Europe/Berlin]'));

    await scheduler.advanceMonths(1);

    expect(seen[0]?.ranAt).toContain('2026-09-05T09:30:00');
  });

  it('leaves the clock at the target once everything has run', async () => {
    const { clock, scheduler } = setup();
    scheduler.schedule(job('a', '2026-09-05T09:30:00+02:00[Europe/Berlin]'));

    await scheduler.advanceMonths(1);

    expect(clock.now().toPlainDate().toString()).toBe('2026-10-01');
  });
});

describe('ordering is deterministic', () => {
  it('runs earlier jobs first regardless of insertion order', async () => {
    const { scheduler, seen } = setup();
    scheduler.schedule(job('third', '2026-09-20T00:00:00+02:00[Europe/Berlin]'));
    scheduler.schedule(job('first', '2026-09-02T00:00:00+02:00[Europe/Berlin]'));
    scheduler.schedule(job('second', '2026-09-10T00:00:00+02:00[Europe/Berlin]'));

    await scheduler.advanceMonths(1);

    expect(seen.map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });

  it('breaks ties on identical times by id, not by insertion order', async () => {
    // A closed period has to recompute byte for byte, and it cannot if the
    // order of two same-instant jobs depends on hash iteration.
    const sameMoment = '2026-09-05T12:00:00+02:00[Europe/Berlin]';

    const forward = setup();
    forward.scheduler.schedule(job('b', sameMoment));
    forward.scheduler.schedule(job('a', sameMoment));
    await forward.scheduler.advanceMonths(1);

    const backward = setup();
    backward.scheduler.schedule(job('a', sameMoment));
    backward.scheduler.schedule(job('b', sameMoment));
    await backward.scheduler.advanceMonths(1);

    expect(forward.seen.map((s) => s.id)).toEqual(['a', 'b']);
    expect(backward.seen.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('jobs scheduled by handlers', () => {
  it('picks up work a handler adds, in the same pass', async () => {
    // This is what makes a dunning chain play out in one call rather than the
    // caller having to know how many rounds it takes.
    const clock = VirtualClock.at(START);
    const seen: string[] = [];
    let attempt = 0;

    const scheduler = new DeterministicScheduler(clock, (j) => {
      seen.push(j.id);
      if (j.kind === 'retry' && attempt < 3) {
        attempt += 1;
        scheduler.schedule({
          id: `retry:inv_1:${attempt}`,
          kind: 'retry',
          runAt: clock.now().add({ days: 3 }),
          payload: null,
        });
      }
    });

    scheduler.schedule({
      id: 'retry:inv_1:0',
      kind: 'retry',
      runAt: at('2026-09-02T00:00:00+02:00[Europe/Berlin]'),
      payload: null,
    });

    await scheduler.advanceMonths(1);

    expect(seen).toEqual([
      'retry:inv_1:0',
      'retry:inv_1:1',
      'retry:inv_1:2',
      'retry:inv_1:3',
    ]);
  });

  it('does not run work a handler schedules beyond the target', async () => {
    const clock = VirtualClock.at(START);
    const seen: string[] = [];

    const scheduler = new DeterministicScheduler(clock, (j) => {
      seen.push(j.id);
      if (j.id === 'a') {
        scheduler.schedule(job('far', '2027-01-01T00:00:00+01:00[Europe/Berlin]'));
      }
    });

    scheduler.schedule(job('a', '2026-09-02T00:00:00+02:00[Europe/Berlin]'));
    await scheduler.advanceMonths(1);

    expect(seen).toEqual(['a']);
    expect(scheduler.pending().map((j) => j.id)).toEqual(['far']);
  });

  it('fails loudly when a handler schedules into the past forever', async () => {
    const clock = VirtualClock.at(START);
    let n = 0;

    const scheduler = new DeterministicScheduler(
      clock,
      () => {
        n += 1;
        scheduler.schedule(job(`loop_${n}`, START));
      },
      { maxJobsPerAdvance: 50 },
    );

    scheduler.schedule(job('loop_0', START));

    await expect(scheduler.advanceMonths(1)).rejects.toThrow(RunawaySchedulerError);
  });
});

describe('identity', () => {
  it('scheduling the same id twice replaces rather than duplicates', async () => {
    // Delivery is at-least-once, so a stable id is what stops a retry becoming
    // a second charge.
    const { scheduler, seen } = setup();
    scheduler.schedule(job('retry:inv_1:2', '2026-09-05T00:00:00+02:00[Europe/Berlin]'));
    scheduler.schedule(job('retry:inv_1:2', '2026-09-05T00:00:00+02:00[Europe/Berlin]'));

    await scheduler.advanceMonths(1);

    expect(seen).toHaveLength(1);
  });

  it('cancels pending work', async () => {
    const { scheduler, seen } = setup();
    scheduler.schedule(job('a', '2026-09-05T00:00:00+02:00[Europe/Berlin]'));

    expect(scheduler.cancel('a')).toBe(true);
    expect(scheduler.cancel('a')).toBe(false);

    await scheduler.advanceMonths(1);
    expect(seen).toEqual([]);
  });
});

describe('calendar awareness', () => {
  it('advancing a month lands on the same day of the next month', async () => {
    const { clock, scheduler } = setup();
    await scheduler.advanceMonths(1);
    expect(clock.now().toPlainDate().toString()).toBe('2026-10-01');
  });

  it('crossing a DST boundary keeps calendar days intact', async () => {
    const clock = VirtualClock.at('2026-10-24T12:00:00+02:00[Europe/Berlin]');
    const scheduler = new DeterministicScheduler(clock, () => undefined);

    await scheduler.advanceDays(2);

    // Winter time starts on the 25th; the 26th is still two calendar days on.
    expect(clock.now().toPlainDate().toString()).toBe('2026-10-26');
  });

  it('steps day by day, reporting what ran each day', async () => {
    const { scheduler } = setup();
    scheduler.schedule(job('a', '2026-09-03T09:00:00+02:00[Europe/Berlin]'));
    scheduler.schedule(job('b', '2026-09-05T09:00:00+02:00[Europe/Berlin]'));

    const days: Array<[string, string[]]> = [];
    await scheduler.advanceDayByDay(6, (day, ran) => {
      days.push([day.toString(), ran.map((j) => j.id)]);
    });

    // Each entry is the day lived through, so a job at 09:00 on the 3rd is
    // reported against the 3rd.
    expect(days).toEqual([
      ['2026-09-01', []],
      ['2026-09-02', []],
      ['2026-09-03', ['a']],
      ['2026-09-04', []],
      ['2026-09-05', ['b']],
      ['2026-09-06', []],
    ]);
  });
});
