import type { Database } from '@billing/db';
import {
  balance,
  createDatabase,
  createMerchant,
  createPool,
  createSubscription,
  ensureMerchantAccounts,
  ingestTransaction,
  invoiceLines,
  merchantWalletKey,
  migrate,
  openInitialInterval,
  planTerms,
  resetSchema,
  systemTotal,
} from '@billing/db';
import { money } from '@billing/domain';
import { SequentialIdGenerator } from '@billing/platform';
import type { Kysely } from 'kysely';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBillingCycle } from './billing-run.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_worker_billing_run';
const TIME_ZONE = 'Europe/Berlin';
const PERIOD = {
  start: Temporal.PlainDate.from('2026-09-01'),
  end: Temporal.PlainDate.from('2026-10-01'),
};

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/**
 * The billing run as production code rather than as a shape each test rebuilds.
 *
 * It used to live inline in two integration tests, which meant the code that
 * turns a month into money was only ever exercised by the tests that also
 * defined it. Now the tests, the worker and the demo seed all call the same
 * function, and disagreeing with it is a failing test rather than a surprise.
 */
describeIfDatabase('runBillingCycle', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let ids: SequentialIdGenerator;

  /** A merchant on the free plan, with a subscription anchored to the period. */
  async function merchant(marketId = 'DE', vatId: string | null = null) {
    const merchantId = ids.next();
    const subscriptionId = ids.next();

    await createMerchant(db, {
      id: merchantId,
      legalEntityId: 'de-gmbh',
      marketId,
      currency: 'EUR',
      email: `run-${merchantId}@example.com`,
      name: 'Cafe Kreuzberg',
      billingTimeZone: TIME_ZONE,
      vatId,
    });
    await createSubscription(db, {
      id: subscriptionId,
      merchantId,
      anchorDate: PERIOD.start,
    });
    await ensureMerchantAccounts(db, merchantId, 'EUR');

    const standard = await planTerms(db, 'standard');
    await db.transaction().execute((tx) =>
      openInitialInterval(tx, subscriptionId, {
        ...standard,
        id: ids.next(),
        effectiveFrom: PERIOD.start,
        effectiveTo: null,
      }),
    );

    return { merchantId, subscriptionId };
  }

  const run = (subscriptionId: string) =>
    runBillingCycle(
      { db, ids },
      {
        subscriptionId,
        period: PERIOD,
        issuedOn: PERIOD.end,
        dueOn: date('2026-10-15'),
      },
    );

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
    ids = new SequentialIdGenerator();
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('turns a month of volume into an issued invoice', async () => {
    const { merchantId, subscriptionId } = await merchant();
    await ingestTransaction(
      db,
      {
        id: ids.next(),
        merchantId,
        gross: eur(413_000),
        channel: 'in_person',
        occurredAt: Temporal.Instant.from('2026-09-09T22:30:00Z'),
      },
      TIME_ZONE,
    );

    const result = await run(subscriptionId);

    expect(result.number).toBe('DE-2026-000001');
    expect(result.total.amount).toBe(8306); // 6980 commission + 19% VAT
    expect(result.alreadyBilled).toBe(false);

    const lines = await invoiceLines(db, result.invoiceId as string);
    expect(lines.map((line) => line.kind)).toEqual(['commission']);

    // The merchant owes it, and the ledger balances.
    expect((await balance(db, merchantWalletKey(merchantId), 'EUR')).amount).toBe(-8306);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('will not bill the same period twice', async () => {
    const { subscriptionId, merchantId } = await merchant();
    await ingestTransaction(
      db,
      {
        id: ids.next(),
        merchantId,
        gross: eur(100_000),
        channel: 'online',
        occurredAt: Temporal.Instant.from('2026-09-10T10:00:00Z'),
      },
      TIME_ZONE,
    );

    const first = await run(subscriptionId);
    const owed = await balance(db, merchantWalletKey(merchantId), 'EUR');

    const second = await run(subscriptionId);

    expect(second.alreadyBilled).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
    // Nothing moved the second time: no second invoice, no second charge.
    expect((await balance(db, merchantWalletKey(merchantId), 'EUR')).amount).toBe(owed.amount);
  });

  it('claims the transactions it billed, so a later period does not re-bill them', async () => {
    const { subscriptionId, merchantId } = await merchant();
    await ingestTransaction(
      db,
      {
        id: ids.next(),
        merchantId,
        gross: eur(50_000),
        channel: 'online',
        occurredAt: Temporal.Instant.from('2026-09-12T10:00:00Z'),
      },
      TIME_ZONE,
    );

    const result = await run(subscriptionId);

    const claimed = await db
      .selectFrom('transactions')
      .select('invoiced_by')
      .where('merchant_id', '=', merchantId)
      .execute();

    expect(claimed.map((row) => row.invoiced_by)).toEqual([result.invoiceId]);
  });

  it('applies the merchant VAT treatment rather than a rate the caller chose', async () => {
    // An Italian business with a VAT ID: the liability is theirs, so the
    // invoice carries no VAT and the ledger has no VAT line to post.
    const { merchantId, subscriptionId } = await merchant('IT', 'IT12345678901');
    await ingestTransaction(
      db,
      {
        id: ids.next(),
        merchantId,
        gross: eur(200_000),
        channel: 'online',
        occurredAt: Temporal.Instant.from('2026-09-14T10:00:00Z'),
      },
      TIME_ZONE,
    );

    const result = await run(subscriptionId);

    const invoice = await db
      .selectFrom('invoices')
      .select(['vat_minor', 'vat_treatment', 'total_minor'])
      .where('id', '=', result.invoiceId as string)
      .executeTakeFirstOrThrow();

    expect(invoice).toMatchObject({ vat_minor: 0, vat_treatment: 'reverse_charge' });
    expect(result.total.amount).toBe(invoice.total_minor);
  });

  it('issues nothing for a period with nothing in it', async () => {
    // A merchant on the free plan who processed no volume owes nothing. An
    // invoice for zero is paperwork nobody asked for, and a ledger transfer of
    // nothing is a row that says nothing.
    const { subscriptionId } = await merchant();

    const result = await run(subscriptionId);

    expect(result.invoiceId).toBeNull();
    expect(result.total.amount).toBe(0);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('announces the invoice so dunning can pick it up', async () => {
    const { merchantId, subscriptionId } = await merchant();
    await ingestTransaction(
      db,
      {
        id: ids.next(),
        merchantId,
        gross: eur(75_000),
        channel: 'online',
        occurredAt: Temporal.Instant.from('2026-09-16T10:00:00Z'),
      },
      TIME_ZONE,
    );

    const result = await run(subscriptionId);

    const events = await db
      .selectFrom('outbox')
      .select('event_type')
      .where('aggregate', '=', `invoice:${result.invoiceId as string}`)
      .execute();

    expect(events.map((event) => event.event_type)).toEqual(['invoice.finalised']);
  });
});
