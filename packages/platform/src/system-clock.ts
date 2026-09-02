import type { Clock } from '@billing/domain';
import { Temporal } from 'temporal-polyfill';

/**
 * The one place in the system that reads ambient time.
 *
 * It lives here rather than in `packages/domain` because the lint rules that
 * enforce ADR-0002 forbid `Temporal.Now` there — and rightly so. Duplicating
 * these six lines into every app's composition root would be worse: the rule
 * would be satisfied while the intent behind it quietly eroded.
 */
export class SystemClock implements Clock {
  readonly #timeZone: string;

  /**
   * @param timeZone IANA identifier. Defaults to UTC rather than the host's
   * zone: a server that silently bills in whatever zone it happens to be
   * deployed in is a bug waiting for a datacentre migration. Merchant-facing
   * calculations use the merchant's own zone, passed explicitly.
   */
  constructor(timeZone = 'UTC') {
    this.#timeZone = timeZone;
  }

  now(): Temporal.ZonedDateTime {
    return Temporal.Now.zonedDateTimeISO(this.#timeZone);
  }
}
