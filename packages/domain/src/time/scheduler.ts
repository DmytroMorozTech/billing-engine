import { Temporal } from 'temporal-polyfill';

import type { Clock } from './clock.js';
import type { VirtualClock } from './clock.js';

export interface ScheduledJob<TPayload = unknown> {
  /**
   * Stable and derived from what the job is for, never random.
   *
   * `retry:${invoiceId}:2` rather than a uuid, so that scheduling the same
   * logical job twice is a no-op rather than a duplicate charge. Delivery is
   * at-least-once (ADR-0005), and this is half of what makes that survivable.
   */
  id: string;
  kind: string;
  runAt: Temporal.ZonedDateTime;
  payload: TPayload;
}

/**
 * Somewhere to put work that should happen later.
 *
 * Production backs this with BullMQ and real delays; tests and the demo back it
 * with {@link DeterministicScheduler}. Domain code only ever sees this
 * interface, which is what lets "advance one month" be a test primitive instead
 * of a month of waiting — see ADR-0002.
 */
export interface JobQueue {
  schedule(job: ScheduledJob): Promise<void> | void;
  cancel(id: string): Promise<boolean> | boolean;
}

export type JobHandler = (job: ScheduledJob, clock: Clock) => void | Promise<void>;

export class RunawaySchedulerError extends Error {
  constructor(limit: number) {
    super(
      `Scheduler ran ${limit} jobs without reaching the target time. A handler is almost certainly scheduling work in the past.`,
    );
    this.name = 'RunawaySchedulerError';
  }
}

export interface DeterministicSchedulerOptions {
  /**
   * Upper bound on jobs executed in one advance, so a handler that reschedules
   * itself into the past fails loudly instead of hanging the test suite.
   */
  maxJobsPerAdvance?: number;
}

/**
 * A scheduler that only moves when told to.
 *
 * Time advances to each due job's scheduled moment before that job runs, so
 * `clock.now()` inside a handler is the time the job was meant to run at — not
 * the target of the advance. Getting that wrong would make every job think it
 * ran late, which is precisely the sort of thing a billing system must not be
 * vague about.
 *
 * Jobs run in `runAt` order, ties broken by id. Determinism is not a nicety
 * here: a closed period has to recompute byte for byte, and it cannot if the
 * order two same-instant jobs ran in was decided by a hash table.
 */
export class DeterministicScheduler implements JobQueue {
  readonly #clock: VirtualClock;
  readonly #handler: JobHandler;
  readonly #maxJobs: number;
  #pending = new Map<string, ScheduledJob>();

  constructor(
    clock: VirtualClock,
    handler: JobHandler,
    options: DeterministicSchedulerOptions = {},
  ) {
    this.#clock = clock;
    this.#handler = handler;
    this.#maxJobs = options.maxJobsPerAdvance ?? 10_000;
  }

  schedule(job: ScheduledJob): void {
    // Same id means the same logical job. Replacing rather than adding is what
    // makes an at-least-once retry harmless.
    this.#pending.set(job.id, job);
  }

  cancel(id: string): boolean {
    return this.#pending.delete(id);
  }

  /** Jobs not yet run, earliest first. */
  pending(): ScheduledJob[] {
    return [...this.#pending.values()].sort(compareJobs);
  }

  now(): Temporal.ZonedDateTime {
    return this.#clock.now();
  }

  /**
   * Moves time to `target`, running everything that falls due on the way.
   *
   * Jobs scheduled by a handler are picked up in the same pass if they too fall
   * due before the target — which is what lets a dunning chain play out in one
   * call instead of needing the caller to know how many rounds it takes.
   */
  async advanceTo(target: Temporal.ZonedDateTime): Promise<ScheduledJob[]> {
    const ran: ScheduledJob[] = [];

    for (let guard = 0; ; guard += 1) {
      if (guard >= this.#maxJobs) {
        throw new RunawaySchedulerError(this.#maxJobs);
      }

      const next = this.#nextDueBy(target);
      if (!next) {
        break;
      }

      this.#pending.delete(next.id);

      // A job scheduled in the past runs now rather than moving time backwards.
      if (Temporal.ZonedDateTime.compare(next.runAt, this.#clock.now()) > 0) {
        this.#clock.setTo(next.runAt);
      }

      await this.#handler(next, this.#clock);
      ran.push(next);
    }

    if (Temporal.ZonedDateTime.compare(target, this.#clock.now()) > 0) {
      this.#clock.setTo(target);
    }

    return ran;
  }

  /** Calendar-aware, so months and DST boundaries behave. */
  async advance(duration: Temporal.Duration | Temporal.DurationLike): Promise<ScheduledJob[]> {
    return this.advanceTo(this.#clock.now().add(duration));
  }

  async advanceDays(days: number): Promise<ScheduledJob[]> {
    return this.advance({ days });
  }

  async advanceMonths(months: number): Promise<ScheduledJob[]> {
    return this.advance({ months });
  }

  /**
   * Steps forward one calendar day at a time.
   *
   * Equivalent in outcome to a single `advance`, but it hands control back
   * between days, which a demo needs in order to show something happening
   * rather than jumping to the end state.
   */
  async advanceDayByDay(
    days: number,
    onDay?: (day: Temporal.PlainDate, ran: readonly ScheduledJob[]) => void | Promise<void>,
  ): Promise<ScheduledJob[]> {
    const all: ScheduledJob[] = [];

    for (let i = 0; i < days; i += 1) {
      // The day reported is the one just lived through, not the one the clock
      // now sits on. A step from midnight on the 3rd covers all of the 3rd and
      // ends at midnight on the 4th; a job at 09:00 on the 3rd belongs to the
      // 3rd, and saying otherwise makes the demo read as if everything happens
      // a day late.
      const day = this.#clock.now().toPlainDate();
      const ran = await this.advance({ days: 1 });
      all.push(...ran);
      await onDay?.(day, ran);
    }

    return all;
  }

  #nextDueBy(target: Temporal.ZonedDateTime): ScheduledJob | undefined {
    let earliest: ScheduledJob | undefined;

    for (const job of this.#pending.values()) {
      if (Temporal.ZonedDateTime.compare(job.runAt, target) > 0) {
        continue;
      }
      if (earliest === undefined || compareJobs(job, earliest) < 0) {
        earliest = job;
      }
    }

    return earliest;
  }
}

function compareJobs(a: ScheduledJob, b: ScheduledJob): number {
  const byTime = Temporal.ZonedDateTime.compare(a.runAt, b.runAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}
