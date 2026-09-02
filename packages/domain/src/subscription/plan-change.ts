import { Temporal } from 'temporal-polyfill';

import type { RateInterval, RateTerms } from '../rating/rate-interval.js';

export interface PlanChangeRequest {
  /** Current knowledge only: intervals whose `supersededAt` is null. */
  currentIntervals: readonly RateInterval[];
  newTerms: RateTerms;
  /** When the change takes effect, as a date in the merchant's billing zone. */
  effectiveFrom: Temporal.PlainDate;
  /** Today in the merchant's billing zone, from the injected Clock. */
  today: Temporal.PlainDate;
  /** Injected so the plan is reproducible; ids are never generated in here. */
  nextId: () => string;
}

/** Close an interval that is still open, without rewriting what we believed. */
export interface CloseInterval {
  id: string;
  effectiveTo: Temporal.PlainDate;
}

/** Replace a version of the timeline, keeping the old one as history. */
export interface SupersedeInterval {
  id: string;
  supersededBy: string;
}

export interface PlanChangePlan {
  /**
   * True when the change reaches into the past and may contradict something
   * already invoiced. Drives which of the two strategies below was used.
   */
  backdated: boolean;
  closes: CloseInterval[];
  supersedes: SupersedeInterval[];
  inserts: RateInterval[];
  /** The timeline that will be current once the plan is applied. */
  resulting: RateInterval[];
}

export class PlanChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanChangeError';
  }
}

/**
 * Works out how a plan change rewrites the rate timeline.
 *
 * Pure. It computes a plan of database operations and applies nothing, so the
 * interesting behaviour — which intervals get superseded, where the boundaries
 * land — is testable without a database and without a clock.
 *
 * ## Two strategies, and why there are two
 *
 * A **prospective** change (effective today or later) is new information, not a
 * correction. Nothing that has already been used to compute an invoice moves.
 * The open interval simply gains an end date and the new one starts there.
 *
 * A **backdated** change is different in kind: it contradicts what we believed
 * during a period that may already have been billed. There, the old version has
 * to survive — otherwise the support console cannot answer "what did we think
 * this merchant's timeline was when we issued that invoice", which is the first
 * question anyone asks about a disputed charge. So every interval the change
 * touches is superseded and a new timeline is laid down beside it.
 *
 * Over-preserving history costs rows. Under-preserving loses evidence. The
 * boundary is drawn to err toward the former.
 */
export function preparePlanChange(request: PlanChangeRequest): PlanChangePlan {
  const { currentIntervals, newTerms, effectiveFrom, today, nextId } = request;

  const intervals = [...currentIntervals].sort((a, b) =>
    Temporal.PlainDate.compare(a.effectiveFrom, b.effectiveFrom),
  );

  const first = intervals[0];
  if (!first) {
    throw new PlanChangeError('Subscription has no rate intervals to change');
  }
  if (Temporal.PlainDate.compare(effectiveFrom, first.effectiveFrom) < 0) {
    throw new PlanChangeError(
      `Cannot take effect on ${effectiveFrom.toString()}, before the subscription started on ${first.effectiveFrom.toString()}`,
    );
  }

  const covering = intervals.find(
    (interval) =>
      Temporal.PlainDate.compare(interval.effectiveFrom, effectiveFrom) <= 0 &&
      (interval.effectiveTo === null ||
        Temporal.PlainDate.compare(interval.effectiveTo, effectiveFrom) > 0),
  );
  if (!covering) {
    throw new PlanChangeError(`No rate is in force on ${effectiveFrom.toString()}`);
  }
  if (covering.planId === newTerms.planId) {
    throw new PlanChangeError(
      `Subscription is already on ${newTerms.planId} on ${effectiveFrom.toString()}`,
    );
  }

  const backdated = Temporal.PlainDate.compare(effectiveFrom, today) < 0;
  const newInterval: RateInterval = {
    ...newTerms,
    id: nextId(),
    effectiveFrom,
    effectiveTo: null,
  };

  // Anything starting at or after the change point is replaced outright: a
  // change supersedes future changes that were already scheduled.
  const laterIntervals = intervals.filter(
    (interval) => Temporal.PlainDate.compare(interval.effectiveFrom, effectiveFrom) >= 0,
  );

  const closes: CloseInterval[] = [];
  const supersedes: SupersedeInterval[] = laterIntervals.map((interval) => ({
    id: interval.id,
    supersededBy: newInterval.id,
  }));
  const inserts: RateInterval[] = [];
  const unchanged = intervals.filter(
    (interval) => Temporal.PlainDate.compare(interval.effectiveFrom, effectiveFrom) < 0,
  );

  const startsExactlyHere = Temporal.PlainDate.compare(covering.effectiveFrom, effectiveFrom) === 0;

  if (startsExactlyHere) {
    // The covering interval would be left zero-length, which the schema forbids
    // and which means nothing anyway. It is already in `supersedes`.
    inserts.push(newInterval);
    return {
      backdated,
      closes,
      supersedes,
      inserts,
      resulting: [...unchanged, newInterval],
    };
  }

  if (backdated) {
    // The covering interval has to shrink, and shrinking it is a rewrite of
    // something we may have already billed. Supersede it and insert the
    // shortened replacement, so both versions remain.
    const shortened: RateInterval = {
      ...covering,
      id: nextId(),
      effectiveTo: effectiveFrom,
    };
    supersedes.unshift({ id: covering.id, supersededBy: shortened.id });
    inserts.push(shortened, newInterval);

    return {
      backdated,
      closes,
      supersedes,
      inserts,
      resulting: [...unchanged.filter((i) => i.id !== covering.id), shortened, newInterval],
    };
  }

  // Prospective: the open interval simply gains an end date.
  closes.push({ id: covering.id, effectiveTo: effectiveFrom });
  inserts.push(newInterval);

  return {
    backdated,
    closes,
    supersedes,
    inserts,
    resulting: [
      ...unchanged.filter((i) => i.id !== covering.id),
      { ...covering, effectiveTo: effectiveFrom },
      newInterval,
    ],
  };
}
