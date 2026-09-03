import { Temporal } from 'temporal-polyfill';

/**
 * When each collection attempt falls, counted in days from the day the invoice
 * was issued.
 *
 * Four attempts over a week. The gaps widen because a card that has failed
 * twice today is rarely fixed by asking again this afternoon, and the whole
 * sequence stays short enough to be watched from beginning to end in a demo
 * that advances time a day at a time.
 *
 * Offsets rather than gaps, because this is the form a support engineer reads
 * off a timeline: "issued on the 1st, suspended on the 8th".
 */
export const RETRY_SCHEDULE_DAYS = [0, 1, 3, 7] as const;

export const ATTEMPTS_ALLOWED = RETRY_SCHEDULE_DAYS.length;

/** What to do once an attempt has come back declined. */
export type AfterFailure =
  | { kind: 'retry'; attempt: number; wait: Temporal.Duration }
  | { kind: 'exhausted' };

/**
 * Decides what follows a failed attempt.
 *
 * Pure, and takes the attempt number rather than counting anything: the number
 * is already part of the attempt's identity — it is in the row and in the key
 * sent to the provider — and a count kept in a second place is a count that
 * will eventually disagree with the first.
 *
 * An attempt number past the last one still answers `exhausted` rather than
 * throwing. A queue that delivers the final attempt twice is normal, and the
 * second delivery must reach the same conclusion as the first.
 */
export function afterFailedAttempt(attempt: number): AfterFailure {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`Attempt must be a whole number from 1, received ${attempt}`);
  }

  if (attempt >= ATTEMPTS_ALLOWED) {
    return { kind: 'exhausted' };
  }

  const from = RETRY_SCHEDULE_DAYS[attempt - 1] as number;
  const to = RETRY_SCHEDULE_DAYS[attempt] as number;

  return {
    kind: 'retry',
    attempt: attempt + 1,
    wait: Temporal.Duration.from({ days: to - from }),
  };
}
