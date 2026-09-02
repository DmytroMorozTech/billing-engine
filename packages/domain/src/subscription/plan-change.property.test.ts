import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { money } from '../money/money.js';
import type { RateInterval, RateTerms } from '../rating/rate-interval.js';
import { PlanChangeError, type PlanChangePlan, preparePlanChange } from './plan-change.js';

const eur = (amount: number) => money(amount, 'EUR');
const START = Temporal.PlainDate.from('2026-01-31');

const PLANS: RateTerms[] = [
  {
    planId: 'standard',
    monthlyFee: eur(0),
    rates: { in_person: 169, online: 250, moto: 295 },
    motoFixedFee: eur(25),
  },
  {
    planId: 'payments_plus',
    monthlyFee: eur(1900),
    rates: { in_person: 99, online: 250, moto: 295 },
    motoFixedFee: eur(25),
  },
  {
    planId: 'enterprise',
    monthlyFee: eur(9900),
    rates: { in_person: 69, online: 190, moto: 250 },
    motoFixedFee: eur(20),
  },
];

/** Days after the subscription started, for both the change date and today. */
const dayOffset = fc.integer({ min: 0, max: 600 });
const planIndex = fc.integer({ min: 0, max: PLANS.length - 1 });

function ids(): () => string {
  let n = 0;
  return () => `gen_${(n += 1)}`;
}

function initialTimeline(): RateInterval[] {
  return [{ ...PLANS[0]!, id: 'ri_1', effectiveFrom: START, effectiveTo: null }];
}

/** Applies a plan the way a repository would, producing the new current set. */
function apply(current: RateInterval[], plan: PlanChangePlan): RateInterval[] {
  const superseded = new Set(plan.supersedes.map((s) => s.id));
  const closedTo = new Map(plan.closes.map((c) => [c.id, c.effectiveTo]));

  const kept = current
    .filter((interval) => !superseded.has(interval.id))
    .map((interval) =>
      closedTo.has(interval.id)
        ? { ...interval, effectiveTo: closedTo.get(interval.id) ?? null }
        : interval,
    );

  return [...kept, ...plan.inserts].sort((a, b) =>
    Temporal.PlainDate.compare(a.effectiveFrom, b.effectiveFrom),
  );
}

/**
 * The invariant the database enforces with a GiST exclusion constraint. The
 * domain has to produce plans that satisfy it, or every plan change becomes a
 * runtime constraint violation instead of a business decision.
 */
function expectTiles(timeline: readonly RateInterval[]): void {
  expect(timeline.length).toBeGreaterThan(0);

  for (let i = 0; i < timeline.length; i += 1) {
    const interval = timeline[i]!;
    const next = timeline[i + 1];

    if (interval.effectiveTo !== null) {
      // No zero-length or inverted intervals: the schema forbids both.
      expect(Temporal.PlainDate.compare(interval.effectiveTo, interval.effectiveFrom)).toBeGreaterThan(0);
    }

    if (next) {
      expect(interval.effectiveTo).not.toBeNull();
      // Meets exactly: no gap to leave a period unpriced, no overlap to price
      // one transaction twice.
      expect(interval.effectiveTo?.equals(next.effectiveFrom)).toBe(true);
    } else {
      expect(interval.effectiveTo).toBeNull();
    }
  }
}

describe('a plan change always leaves a well-formed timeline', () => {
  it('holds for a single change at any date, prospective or backdated', () => {
    fc.assert(
      fc.property(dayOffset, dayOffset, planIndex, (changeOffset, todayOffset, index) => {
        const current = initialTimeline();
        const newTerms = PLANS[index]!;
        const effectiveFrom = START.add({ days: changeOffset });
        const today = START.add({ days: todayOffset });

        let plan: PlanChangePlan;
        try {
          plan = preparePlanChange({
            currentIntervals: current,
            newTerms,
            effectiveFrom,
            today,
            nextId: ids(),
          });
        } catch (error) {
          // The only legitimate refusal here is changing to the plan already
          // in force; anything else would be a bug.
          expect(error).toBeInstanceOf(PlanChangeError);
          expect(newTerms.planId).toBe('standard');
          return;
        }

        expectTiles(apply(current, plan));
        expect(plan.backdated).toBe(Temporal.PlainDate.compare(effectiveFrom, today) < 0);
      }),
    );
  });

  it('holds across a sequence of changes applied one after another', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ offset: dayOffset, index: planIndex, todayOffset: dayOffset }), {
          minLength: 1,
          maxLength: 8,
        }),
        (changes) => {
          let timeline = initialTimeline();
          const nextId = ids();

          for (const change of changes) {
            try {
              const plan = preparePlanChange({
                currentIntervals: timeline,
                newTerms: PLANS[change.index]!,
                effectiveFrom: START.add({ days: change.offset }),
                today: START.add({ days: change.todayOffset }),
                nextId,
              });
              timeline = apply(timeline, plan);
            } catch (error) {
              // Refusals are fine — they must simply not corrupt the timeline.
              expect(error).toBeInstanceOf(PlanChangeError);
            }

            expectTiles(timeline);
          }
        },
      ),
    );
  });
});

describe('history is never destroyed by a backdated change', () => {
  it('every superseded interval is replaced by something that was inserted', () => {
    fc.assert(
      fc.property(dayOffset, dayOffset, planIndex, (changeOffset, todayOffset, index) => {
        const current = initialTimeline();
        const newTerms = PLANS[index]!;
        if (newTerms.planId === 'standard') return;

        const plan = preparePlanChange({
          currentIntervals: current,
          newTerms,
          effectiveFrom: START.add({ days: changeOffset }),
          today: START.add({ days: todayOffset }),
          nextId: ids(),
        });

        const insertedIds = new Set(plan.inserts.map((i) => i.id));
        for (const supersede of plan.supersedes) {
          // A row pointing at a superseding row that was never inserted would
          // fail the foreign key at COMMIT.
          expect(insertedIds.has(supersede.supersededBy)).toBe(true);
        }

        // A backdated change preserves rather than mutates.
        if (plan.backdated) {
          expect(plan.closes).toEqual([]);
        }
      }),
    );
  });
});
