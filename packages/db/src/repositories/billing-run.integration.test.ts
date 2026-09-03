import {
  buildInvoice,
  money,
  preparePlanChange,
  type Derivation,
  type InvoiceDraft,
} from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import {
  finaliseInvoice,
  invoiceLines,
  periodAlreadyInvoiced,
  persistInvoiceDraft,
} from './invoices.js';
import {
  balance,
  ensureMerchantAccounts,
  invoicePostings,
  merchantWalletKey,
  postTransfer,
  systemTotal,
  UnbalancedTransferError,
} from './ledger.js';
import {
  applyPlanChange,
  currentRateIntervals,
  openInitialInterval,
  planTerms,
} from './subscriptions.js';
import { ingestTransaction, markInvoiced, uninvoicedInPeriod } from './transactions.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

/** Own schema, for the same reason as the other integration files. */
const SCHEMA = 'test_billing_run';

const MERCHANT = '00000000-0000-7000-8000-0000000000e1';
const SUBSCRIPTION = '00000000-0000-7000-8000-0000000000e2';
const INVOICE = '00000000-0000-7000-8000-0000000000e3';
const TRANSFER = '00000000-0000-7000-8000-0000000000e4';

const TIME_ZONE = 'Europe/Berlin';
const PERIOD = {
  start: Temporal.PlainDate.from('2026-09-01'),
  end: Temporal.PlainDate.from('2026-10-01'),
};

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/**
 * The whole of Stage 1, composed: a merchant processes volume, changes plan
 * mid-cycle, and a billing run turns that into an invoice with explanations and
 * a balanced set of ledger entries.
 *
 * Each piece has its own tests. This is the one that proves they fit together,
 * which is the part that unit tests structurally cannot check.
 */
describeIfDatabase('a billing run end to end', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;
  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  let draft: InvoiceDraft;
  let billedTransactionIds: string[];

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
        email: 'run@example.com',
        name: 'Cafe Kreuzberg',
        billing_time_zone: TIME_ZONE,
        vat_id: null,
      })
      .execute();

    await db
      .insertInto('subscriptions')
      .values({
        id: SUBSCRIPTION,
        merchant_id: MERCHANT,
        anchor_date: '2026-09-01',
        status: 'active',
        started_on: '2026-09-01',
        cancelled_on: null,
      })
      .execute();

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
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('records volume against the local date in the merchant time zone', async () => {
    // 22:30 UTC on 9 September is already the 10th in Berlin. Getting this
    // wrong moves a transaction into the neighbouring rate segment.
    const occurredOn = await ingestTransaction(
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

    expect(occurredOn.toString()).toBe('2026-09-10');

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
  });

  it('upgrades the plan mid-cycle', async () => {
    const plus = await planTerms(db, 'payments_plus');
    const current = await currentRateIntervals(db, SUBSCRIPTION);

    const plan = preparePlanChange({
      currentIntervals: current,
      newTerms: plus,
      effectiveFrom: date('2026-09-15'),
      today: date('2026-09-15'),
      nextId,
    });

    await db.transaction().execute((tx) => applyPlanChange(tx, SUBSCRIPTION, plan));

    const intervals = await currentRateIntervals(db, SUBSCRIPTION);
    expect(intervals.map((i) => i.planId)).toEqual(['standard', 'payments_plus']);
  });

  it('computes the invoice from what the database holds', async () => {
    const intervals = await currentRateIntervals(db, SUBSCRIPTION);
    const transactions = await uninvoicedInPeriod(db, MERCHANT, PERIOD);
    billedTransactionIds = transactions.map((t) => t.id);

    expect(transactions).toHaveLength(2);

    draft = buildInvoice({
      period: PERIOD,
      currency: 'EUR',
      intervals,
      transactions,
      vat: { kind: 'standard', rateBps: 1900 },
    });

    // The worked example from ADR-0006, reached entirely through the database.
    expect(draft.lines.map((l) => l.amount.amount)).toEqual([1013, 6980, 3831]);
    expect(draft.subtotal.amount).toBe(11_824);
    expect(draft.vat.amount).toBe(2247);
    expect(draft.total.amount).toBe(14_071);
  });

  it('persists the invoice, its lines and their explanations', async () => {
    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id: INVOICE,
        merchantId: MERCHANT,
        subscriptionId: SUBSCRIPTION,
        legalEntityId: 'de-gmbh',
        draft,
        lineIds: draft.lines.map(() => nextId()),
      });
      await markInvoiced(tx, billedTransactionIds, INVOICE);
    });

    const lines = await invoiceLines(db, INVOICE);
    expect(lines.map((l) => l.amountMinor)).toEqual([1013, 6980, 3831]);

    // The explanation survives the round trip through JSONB intact, including
    // the pre-rounding value that makes 6980 checkable by hand.
    const commission = lines[1]?.derivation as Derivation;
    expect(commission.formula).toBe('volume × rate');
    expect(commission.rounding?.exact).toBe('6979.70');
    expect(commission.result).toEqual({ amount: 6980, currency: 'EUR' });
  });

  it('issues the invoice with a number once it leaves draft', async () => {
    // The run fires when the period closes, so that is the issue date; net 14
    // is the payment term the dunning schedule will count from.
    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, INVOICE, { issuedOn: date('2026-10-01'), dueOn: date('2026-10-15') }),
      );

    expect(number).toBe('DE-2026-000001');

    const invoice = await db
      .selectFrom('invoices')
      .select(['number', 'status', 'issued_on', 'due_on'])
      .where('id', '=', INVOICE)
      .executeTakeFirstOrThrow();

    expect(invoice).toEqual({
      number: 'DE-2026-000001',
      status: 'open',
      issued_on: '2026-10-01',
      due_on: '2026-10-15',
    });
  });

  it('will not bill the same period twice', async () => {
    expect(await periodAlreadyInvoiced(db, SUBSCRIPTION, '2026-09-01')).toBe(true);

    // The transactions are spoken for, so a repeated run finds nothing to bill.
    const remaining = await uninvoicedInPeriod(db, MERCHANT, PERIOD);
    expect(remaining).toEqual([]);
  });

  it('posts a balanced set of ledger entries for the invoice', async () => {
    await db.transaction().execute((tx) =>
      postTransfer(tx, {
        id: TRANSFER,
        kind: 'invoice_charge',
        occurredAt: new Date('2026-10-01T00:00:00Z'),
        reference: { type: 'invoice', id: INVOICE },
        postings: invoicePostings({
          merchantId: MERCHANT,
          subtotal: draft.subtotal,
          vat: draft.vat,
          total: draft.total,
        }),
      }),
    );

    const wallet = await balance(db, merchantWalletKey(MERCHANT), 'EUR');
    expect(wallet.amount).toBe(-14_071);
    expect((await balance(db, 'platform:revenue', 'EUR')).amount).toBe(11_824);
    expect((await balance(db, 'platform:vat_payable', 'EUR')).amount).toBe(2247);
  });

  it('keeps the whole system summing to zero', async () => {
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('refuses an unbalanced transfer before it reaches the database', async () => {
    await expect(
      db.transaction().execute((tx) =>
        postTransfer(tx, {
          id: nextId(),
          kind: 'broken',
          occurredAt: new Date(),
          postings: [
            { accountKey: merchantWalletKey(MERCHANT), amount: eur(-100) },
            { accountKey: 'platform:revenue', amount: eur(99) },
          ],
        }),
      ),
    ).rejects.toThrow(UnbalancedTransferError);

    // And nothing was written, so the system still balances.
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });
});
