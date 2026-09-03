import { buildInvoice, preparePlanChange, type RatedTransaction } from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import {
  applyPlanChange,
  currentRateIntervals,
  openInitialInterval,
  planTerms,
  rateIntervalsAsKnownAt,
} from './subscriptions.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

/** Own schema, for the same reason as the constraints test file. */
const SCHEMA = 'test_repositories';

const MERCHANT = '00000000-0000-7000-8000-0000000000d1';
const SUBSCRIPTION = '00000000-0000-7000-8000-0000000000d2';
const date = (iso: string) => Temporal.PlainDate.from(iso);

/**
 * Closes the loop that the unit tests cannot: the domain computes a plan, the
 * repository applies it, and PostgreSQL either accepts the result or refuses
 * it. Both sides claim to uphold the same invariant — no two rates in force at
 * once — and this is where that claim is actually tested.
 */
describeIfDatabase('applying a plan change', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;
  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);

    await db
      .insertInto('merchants')
      .values({
        id: MERCHANT,
        legal_entity_id: 'de-gmbh',
        market_id: 'DE',
        currency: 'EUR',
        email: 'cafe@example.com',
        name: 'Cafe Kreuzberg',
        billing_time_zone: 'Europe/Berlin',
        vat_id: null,
      })
      .execute();

    await db
      .insertInto('subscriptions')
      .values({
        id: SUBSCRIPTION,
        merchant_id: MERCHANT,
        anchor_date: '2026-01-31',
        status: 'active',
        started_on: '2026-01-31',
        cancelled_on: null,
      })
      .execute();

    const standard = await planTerms(db, 'standard');
    await db.transaction().execute((tx) =>
      openInitialInterval(tx, SUBSCRIPTION, {
        ...standard,
        id: nextId(),
        effectiveFrom: date('2026-01-31'),
        effectiveTo: null,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('starts with one open interval on the free plan', async () => {
    const intervals = await currentRateIntervals(db, SUBSCRIPTION);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.planId).toBe('standard');
    expect(intervals[0]?.effectiveTo).toBeNull();
  });

  it('applies a prospective upgrade by closing the open interval', async () => {
    const plus = await planTerms(db, 'payments_plus');
    const current = await currentRateIntervals(db, SUBSCRIPTION);

    const plan = preparePlanChange({
      currentIntervals: current,
      newTerms: plus,
      effectiveFrom: date('2026-09-15'),
      today: date('2026-09-15'),
      nextId,
    });

    expect(plan.backdated).toBe(false);
    await db.transaction().execute((tx) => applyPlanChange(tx, SUBSCRIPTION, plan));

    const after = await currentRateIntervals(db, SUBSCRIPTION);
    expect(
      after.map((i) => [i.planId, i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null]),
    ).toEqual([
      ['standard', '2026-01-31', '2026-09-15'],
      ['payments_plus', '2026-09-15', null],
    ]);
  });

  it('applies a backdated correction without tripping the exclusion constraint', async () => {
    const knownBefore = new Date();
    const plus = await planTerms(db, 'payments_plus');
    const current = await currentRateIntervals(db, SUBSCRIPTION);

    // The merchant actually upgraded on the 5th. This supersedes both existing
    // intervals and inserts a new pair — the case that needs the deferred
    // foreign key, because the superseding rows do not exist until COMMIT.
    const plan = preparePlanChange({
      currentIntervals: current,
      newTerms: plus,
      effectiveFrom: date('2026-09-05'),
      today: date('2026-09-20'),
      nextId,
    });

    expect(plan.backdated).toBe(true);
    expect(plan.supersedes).toHaveLength(2);

    await db.transaction().execute((tx) => applyPlanChange(tx, SUBSCRIPTION, plan));

    const after = await currentRateIntervals(db, SUBSCRIPTION);
    expect(
      after.map((i) => [i.planId, i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null]),
    ).toEqual([
      ['standard', '2026-01-31', '2026-09-05'],
      ['payments_plus', '2026-09-05', null],
    ]);

    // History survives: the timeline as it was believed before the correction
    // is still readable, which is what the support console needs.
    const asKnown = await rateIntervalsAsKnownAt(db, SUBSCRIPTION, knownBefore);
    expect(
      asKnown.map((i) => [i.effectiveFrom.toString(), i.effectiveTo?.toString() ?? null]),
    ).toEqual([
      ['2026-01-31', '2026-09-15'],
      ['2026-09-15', null],
    ]);
  });

  it('changes the invoice, computed from what the database now holds', async () => {
    const intervals = await currentRateIntervals(db, SUBSCRIPTION);
    const transactions: RatedTransaction[] = [
      {
        id: 't1',
        gross: { amount: 413_000, currency: 'EUR' },
        channel: 'in_person',
        occurredOn: date('2026-09-10'),
      },
      {
        id: 't2',
        gross: { amount: 387_000, currency: 'EUR' },
        channel: 'in_person',
        occurredOn: date('2026-09-20'),
      },
    ];

    const invoice = buildInvoice({
      period: { start: date('2026-09-01'), end: date('2026-10-01') },
      currency: 'EUR',
      intervals,
      transactions,
      vat: { kind: 'standard' as const, rateBps: 1900 },
    });

    // Matches the unit test that used hand-built intervals — the round trip
    // through PostgreSQL changes nothing.
    expect(invoice.lines.map((l) => l.amount.amount)).toEqual([1647, 7920]);
    expect(invoice.total.amount).toBe(11_385);
  });

  it('refuses a timeline the domain would never produce', async () => {
    // Belt and braces: if a bug ever let the domain emit an overlapping
    // interval, the database is the thing that stops it reaching production.
    const plus = await planTerms(db, 'payments_plus');
    await expect(
      db.transaction().execute((tx) =>
        openInitialInterval(tx, SUBSCRIPTION, {
          ...plus,
          id: nextId(),
          effectiveFrom: date('2026-09-10'),
          effectiveTo: null,
        }),
      ),
    ).rejects.toThrow(/exclusion constraint/i);
  });
});
