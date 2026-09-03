import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { ATTEMPTS_ALLOWED, RETRY_SCHEDULE_DAYS, afterFailedAttempt } from './dunning.js';

const days = (d: number) => Temporal.Duration.from({ days: d });

describe('afterFailedAttempt', () => {
  it('waits a day after the first failure', () => {
    expect(afterFailedAttempt(1)).toEqual({ kind: 'retry', attempt: 2, wait: days(1) });
  });

  it('waits longer each time', () => {
    // Growing gaps, because the reason a card fails twice in a day is rarely
    // fixed by asking a third time an hour later.
    expect(afterFailedAttempt(2)).toEqual({ kind: 'retry', attempt: 3, wait: days(2) });
    expect(afterFailedAttempt(3)).toEqual({ kind: 'retry', attempt: 4, wait: days(4) });
  });

  it('gives up after the last attempt', () => {
    expect(afterFailedAttempt(ATTEMPTS_ALLOWED)).toEqual({ kind: 'exhausted' });
  });

  it('stays given up if asked again', () => {
    // A duplicate delivery of the final attempt must not restart the sequence.
    expect(afterFailedAttempt(ATTEMPTS_ALLOWED + 3)).toEqual({ kind: 'exhausted' });
  });

  it('refuses an attempt number that cannot exist', () => {
    expect(() => afterFailedAttempt(0)).toThrow(RangeError);
    expect(() => afterFailedAttempt(1.5)).toThrow(RangeError);
  });

  it('lands the whole sequence where the schedule says', () => {
    // The waits are gaps between attempts; the schedule is offsets from the
    // day the invoice was issued. Stating both and checking they agree is the
    // point: it is the second one a support engineer reads off a timeline.
    let offset = RETRY_SCHEDULE_DAYS[0] as number;
    const landed = [offset];

    for (let attempt = 1; attempt < ATTEMPTS_ALLOWED; attempt += 1) {
      const next = afterFailedAttempt(attempt);
      if (next.kind !== 'retry') {
        throw new Error(`attempt ${attempt} should still have a retry`);
      }
      offset += next.wait.days;
      landed.push(offset);
    }

    expect(landed).toEqual([...RETRY_SCHEDULE_DAYS]);
    expect(landed).toEqual([0, 1, 3, 7]);
  });
});
