import { Temporal } from 'temporal-polyfill';

/**
 * The only way domain code is allowed to learn what time it is.
 *
 * `Date` and `Temporal.Now` do not appear anywhere under `packages/domain` —
 * a lint rule enforces it. See ADR-0002.
 */
export interface Clock {
  now(): Temporal.ZonedDateTime;
}

/**
 * A clock that only moves when told to.
 *
 * This is what turns "what does this subscription look like after eleven
 * renewals" from an eleven-month wait into a millisecond. It lives in the
 * domain package because it is pure: it reads no ambient state.
 */
export class VirtualClock implements Clock {
  #current: Temporal.ZonedDateTime;

  constructor(start: Temporal.ZonedDateTime) {
    this.#current = start;
  }

  /** Builds a clock from an ISO string, e.g. `2026-09-01T00:00:00+02:00[Europe/Berlin]`. */
  static at(isoZonedDateTime: string): VirtualClock {
    return new VirtualClock(Temporal.ZonedDateTime.from(isoZonedDateTime));
  }

  now(): Temporal.ZonedDateTime {
    return this.#current;
  }

  /**
   * Moves the clock forward by a calendar-aware duration.
   *
   * `advance({ days: 1 })` crosses a DST boundary correctly — the resulting
   * instant may be 23 or 25 hours later, which is the point.
   */
  advance(duration: Temporal.Duration | Temporal.DurationLike): this {
    this.#current = this.#current.add(duration);
    return this;
  }

  setTo(instant: Temporal.ZonedDateTime): this {
    this.#current = instant;
    return this;
  }
}
