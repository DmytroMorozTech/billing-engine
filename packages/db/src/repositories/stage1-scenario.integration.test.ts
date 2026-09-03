import {
  buildInvoice,
  currentPeriod,
  DeterministicScheduler,
  money,
  preparePlanChange,
  VirtualClock,
  type ScheduledJob,
} from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { invoiceLines, persistInvoiceDraft } from './invoices.js';
import {
  balance,
  ensureMerchantAccounts,
  invoicePostings,
  merchantWalletKey,
  postTransfer,
  systemTotal,
} from './ledger.js';
import { createMerchant, createSubscription, merchantContext } from './merchants.js';
import { applyPlanChange, currentRateIntervals, openInitialInterval, planTerms } from './subscriptions.js';
import { ingestTransaction, markInvoiced, uninvoicedInPeriod } from './transactions.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_stage1_scenario';
const MERCHANT = '00000000-0000-7000-8000-000000000a01';
const SUBSCRIPTION = '00000000-0000-7000-8000-000000000a02';
const START = '2026-09-01T00:00:00+02:00[Europe/Berlin]';
const TIME_ZONE = 'Europe/Berlin';

const eur = (amount: number) => money(amount, 'EUR');
const date = (iso: string) => Temporal.PlainDate.from(iso);

/**
 * The acceptance criterion for Stage 1, exactly as the roadmap words it:
 *
 *   create merchant, process transactions, change plan mid-cycle, advance one
 *   month — produces a correct invoice, and the ledger balances.
 *
 * Nothing is stubbed. Time is virtual, but every calculation, every constraint
 * and every row is real. The month passes in milliseconds because the clock is
 * injected, which is the entire argument of ADR-0002.
 */
describeIfDatabase('Stage 1 acceptance scenario', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let clock: VirtualClock;
  let scheduler: DeterministicScheduler;
  let counter = 0;
  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  const invoicesRaised: string[] = [];

  /** What the worker will do for real, once apps/worker exists. */
  async function runBilling(job: ScheduledJob): Promise<void> {
    const merchant = await merchantContext(db, MERCHANT);
    const period = currentPeriod(date('2026-09-01'), clock, merchant.billingTimeZone);

    // The run fires on the first day of the next period, so bill the one that
    // has just closed.
    const closed = {
      start: period.start.subtract({ months: 1 }),
      end: period.start,
    };

    const intervals = await currentRateIntervals(db, SUBSCRIPTION);
    const transactions = await uninvoicedInPeriod(db, MERCHANT, closed);

    const draft = buildInvoice({
      period: closed,
      currency: merchant.currency,
      intervals,
      transactions,
      vat: { kind: 'standard', rateBps: merchant.vatRateBps },
    });

    const invoiceId = nextId();
    const transferId = nextId();

    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id: invoiceId,
        merchantId: MERCHANT,
        subscriptionId: SUBSCRIPTION,
        legalEntityId: merchant.legalEntityId,
        draft,
        lineIds: draft.lines.map(() => nextId()),
      });
      await markInvoiced(
        tx,
        transactions.map((t) => t.id),
        invoiceId,
      );
      await postTransfer(tx, {
        id: transferId,
        kind: job.kind,
        occurredAt: new Date(clock.now().epochMilliseconds),
        reference: { type: 'invoice', id: invoiceId },
        postings: invoicePostings({
          merchantId: MERCHANT,
          subtotal: draft.subtotal,
          vat: draft.vat,
          total: draft.total,
        }),
      });
    });

    invoicesRaised.push(invoiceId);
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);

    clock = VirtualClock.at(START);
    scheduler = new DeterministicScheduler(clock, (job) => runBilling(job));
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('creates a merchant on the free plan', async () => {
    await createMerchant(db, {
      id: MERCHANT,
      legalEntityId: 'de-gmbh',
      marketId: 'DE',
      currency: 'EUR',
      email: 'scenario@example.com',
      name: 'Cafe Kreuzberg',
      billingTimeZone: TIME_ZONE,
    });
    await createSubscription(db, {
      id: SUBSCRIPTION,
      merchantId: MERCHANT,
      anchorDate: date('2026-09-01'),
    });
    await ensureMerchantAccounts(db, MERCHANT, 'EUR');

    const standard = await planTerms(db, 'standard');
    await db.transaction().execute((tx) =>
      openInitialInterval(tx, SUBSCRIPTION, {
        ...standard,
        id: nextId(),
        effectiveFrom: date('2026-09-01'),
        effectiveTo: null,
      }),
    );

    const merchant = await merchantContext(db, MERCHANT);
    expect(merchant.vatRateBps).toBe(1900);
    expect(merchant.billingTimeZone).toBe(TIME_ZONE);
  });

  it('schedules the billing run for the end of the period', () => {
    scheduler.schedule({
      id: `billing-run:${SUBSCRIPTION}:2026-09`,
      kind: 'billing_run',
      // The period is half-open [1 Sep, 1 Oct), so it closes at exactly midnight
      // on the 1st — which is when there is something to bill.
      runAt: Temporal.ZonedDateTime.from('2026-10-01T00:00:00+02:00[Europe/Berlin]'),
      payload: { subscriptionId: SUBSCRIPTION },
    });

    expect(scheduler.pending()).toHaveLength(1);
  });

  it('processes volume and upgrades mid-cycle', async () => {
    await ingestTransaction(
      db,
      {
        id: nextId(),
        merchantId: MERCHANT,
        gross: eur(413_000),
        channel: 'in_person',
        occurredAt: Temporal.Instant.from('2026-09-09T22:30:00Z'),
      },
      TIME_ZONE,
    );
    await ingestTransaction(
      db,
      {
        id: nextId(),
        merchantId: MERCHANT,
        gross: eur(387_000),
        channel: 'in_person',
        occurredAt: Temporal.Instant.from('2026-09-20T09:00:00Z'),
      },
      TIME_ZONE,
    );

    const plus = await planTerms(db, 'payments_plus');
    const plan = preparePlanChange({
      currentIntervals: await currentRateIntervals(db, SUBSCRIPTION),
      newTerms: plus,
      effectiveFrom: date('2026-09-15'),
      today: date('2026-09-15'),
      nextId,
    });
    await db.transaction().execute((tx) => applyPlanChange(tx, SUBSCRIPTION, plan));

    // Nothing has been billed: the run has not fired yet.
    expect(invoicesRaised).toHaveLength(0);
  });

  it('advances one month, and the billing run fires on its own', async () => {
    const ran = await scheduler.advanceMonths(1);

    expect(ran.map((j) => j.kind)).toEqual(['billing_run']);
    expect(clock.now().toPlainDate().toString()).toBe('2026-10-01');
    expect(invoicesRaised).toHaveLength(1);
  });

  it('produced the correct invoice', async () => {
    const lines = await invoiceLines(db, invoicesRaised[0] as string);

    expect(lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ['subscription', 1013],
      ['commission', 6980],
      ['commission', 3831],
    ]);

    const invoice = await db
      .selectFrom('invoices')
      .select(['subtotal_minor', 'vat_minor', 'total_minor', 'period_start', 'period_end'])
      .where('id', '=', invoicesRaised[0] as string)
      .executeTakeFirstOrThrow();

    expect(invoice.period_start).toBe('2026-09-01');
    expect(invoice.period_end).toBe('2026-10-01');
    expect(invoice.subtotal_minor).toBe(11_824);
    expect(invoice.vat_minor).toBe(2247);
    expect(invoice.total_minor).toBe(14_071);
  });

  it('left the ledger balanced', async () => {
    expect((await balance(db, merchantWalletKey(MERCHANT), 'EUR')).amount).toBe(-14_071);
    expect((await balance(db, 'platform:revenue', 'EUR')).amount).toBe(11_824);
    expect((await balance(db, 'platform:vat_payable', 'EUR')).amount).toBe(2247);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('is idempotent: another month produces no second invoice for the period', async () => {
    // The run already consumed its scheduled job, and the transactions are
    // spoken for. Re-running the same period must be a no-op, not a re-charge.
    await scheduler.advanceMonths(1);

    expect(invoicesRaised).toHaveLength(1);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });
});
