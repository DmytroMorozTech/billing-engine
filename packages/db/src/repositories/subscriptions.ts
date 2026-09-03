import type { PlanChangePlan, RateInterval, RateTerms } from '@billing/domain';
import type { Kysely, Transaction } from 'kysely';

import {
  fromPlainDate,
  rateIntervalValues,
  termsFromRow,
  toRateInterval,
} from '../mappers.js';
import type { Database } from '../schema.js';

export type Db = Kysely<Database> | Transaction<Database>;

/**
 * Reads the rate timeline as it is currently believed to be.
 *
 * Superseded rows are excluded: they are history, and the domain reasons about
 * one timeline at a time. Reading history is a separate, explicit call.
 */
export async function currentRateIntervals(
  db: Db,
  subscriptionId: string,
): Promise<RateInterval[]> {
  const rows = await db
    .selectFrom('rate_intervals')
    .select([
      'id',
      'plan_id',
      'monthly_fee_minor',
      'currency',
      'in_person_rate_bps',
      'online_rate_bps',
      'moto_rate_bps',
      'moto_fixed_fee_minor',
      'effective_from',
      'effective_to',
    ])
    .where('subscription_id', '=', subscriptionId)
    .where('superseded_at', 'is', null)
    .orderBy('effective_from')
    .execute();

  return rows.map(toRateInterval);
}

/** The timeline as it was believed to be at a past moment. */
export async function rateIntervalsAsKnownAt(
  db: Db,
  subscriptionId: string,
  asOf: Date,
): Promise<RateInterval[]> {
  const rows = await db
    .selectFrom('rate_intervals')
    .select([
      'id',
      'plan_id',
      'monthly_fee_minor',
      'currency',
      'in_person_rate_bps',
      'online_rate_bps',
      'moto_rate_bps',
      'moto_fixed_fee_minor',
      'effective_from',
      'effective_to',
    ])
    .where('subscription_id', '=', subscriptionId)
    .where('recorded_at', '<=', asOf)
    .where((eb) =>
      eb.or([eb('superseded_at', 'is', null), eb('superseded_at', '>', asOf)]),
    )
    .orderBy('effective_from')
    .execute();

  return rows.map(toRateInterval);
}

export async function findPlanTerms(db: Db, planId: string): Promise<RateTerms | undefined> {
  const row = await db
    .selectFrom('plans')
    .select([
      'id',
      'monthly_fee_minor',
      'currency',
      'in_person_rate_bps',
      'online_rate_bps',
      'moto_rate_bps',
      'moto_fixed_fee_minor',
    ])
    .where('id', '=', planId)
    .executeTakeFirst();

  return row === undefined ? undefined : termsFromRow(row.id, row);
}

export async function planTerms(db: Db, planId: string): Promise<RateTerms> {
  const terms = await findPlanTerms(db, planId);
  if (terms === undefined) {
    throw new Error(`No plan with id ${planId}`);
  }
  return terms;
}

/**
 * Applies a plan computed by the domain.
 *
 * The order matters and is not interchangeable. Superseding comes first, so a
 * backdated interval is out of the partial exclusion constraint's way before
 * its replacement is inserted. The `superseded_by` foreign key points at rows
 * that only exist by the end of the transaction, which is why it is declared
 * `DEFERRABLE INITIALLY DEFERRED` — see ADR-0009.
 *
 * Takes a `Transaction`, not a `Kysely`, so it cannot accidentally be run
 * outside one. Half of this applied is a corrupt timeline.
 */
export async function applyPlanChange(
  tx: Transaction<Database>,
  subscriptionId: string,
  plan: PlanChangePlan,
): Promise<void> {
  for (const supersede of plan.supersedes) {
    await tx
      .updateTable('rate_intervals')
      .set({ superseded_at: new Date(), superseded_by: supersede.supersededBy })
      .where('id', '=', supersede.id)
      .where('superseded_at', 'is', null)
      .execute();
  }

  for (const close of plan.closes) {
    await tx
      .updateTable('rate_intervals')
      .set({ effective_to: fromPlainDate(close.effectiveTo) })
      .where('id', '=', close.id)
      .where('superseded_at', 'is', null)
      .execute();
  }

  if (plan.inserts.length > 0) {
    await tx
      .insertInto('rate_intervals')
      .values(plan.inserts.map((interval) => rateIntervalValues(interval, subscriptionId)))
      .execute();
  }
}

/** Opens the first interval of a brand-new subscription. */
export async function openInitialInterval(
  tx: Transaction<Database>,
  subscriptionId: string,
  interval: RateInterval,
): Promise<void> {
  await tx
    .insertInto('rate_intervals')
    .values(rateIntervalValues(interval, subscriptionId))
    .execute();
}
