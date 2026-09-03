import { buildInvoice, money } from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { persistInvoiceDraft } from './invoices.js';
import { invoicePostings } from './ledger.js';
import { createMerchant, createSubscription, merchantContext, vatTreatmentFor } from './merchants.js';
import { openInitialInterval, planTerms } from './subscriptions.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_vat_treatment';
const PERIOD = {
  start: Temporal.PlainDate.from('2026-09-01'),
  end: Temporal.PlainDate.from('2026-10-01'),
};

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/**
 * VAT decided from what the database knows about a merchant.
 *
 * The rule itself is pure and tested in the domain. What is tested here is the
 * wiring: that the market's rate, its reverse-charge availability and the
 * merchant's VAT ID reach the rule, and that the answer survives onto the
 * invoice row where an auditor can find it.
 */
describeIfDatabase('VAT treatment from merchant context', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;

  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  /** A merchant, its subscription on the paid plan, and its rate interval. */
  async function merchant(
    marketId: string,
    vatId: string | null,
  ): Promise<{ merchantId: string; subscriptionId: string }> {
    const id = nextId();
    const subscriptionId = nextId();

    await createMerchant(db, {
      id,
      legalEntityId: 'de-gmbh',
      marketId,
      currency: 'EUR',
      email: `${marketId}-${counter}@example.com`,
      name: `Merchant ${marketId}`,
      billingTimeZone: 'Europe/Berlin',
      vatId,
    });
    await createSubscription(db, { id: subscriptionId, merchantId: id, anchorDate: date('2026-09-01') });

    const plus = await planTerms(db, 'payments_plus');
    await db.transaction().execute((tx) =>
      openInitialInterval(tx, subscriptionId, {
        ...plus,
        id: nextId(),
        effectiveFrom: date('2026-09-01'),
        effectiveTo: null,
      }),
    );

    return { merchantId: id, subscriptionId };
  }

  /** Bills one empty period, so the only line is the subscription fee. */
  async function invoiceFor(merchantId: string, subscriptionId: string) {
    const context = await merchantContext(db, merchantId);
    const intervals = await db
      .selectFrom('rate_intervals')
      .selectAll()
      .where('subscription_id', '=', subscriptionId)
      .execute();
    expect(intervals).toHaveLength(1);

    const draft = buildInvoice({
      period: PERIOD,
      currency: context.currency,
      intervals: [
        {
          id: intervals[0]?.id as string,
          planId: 'payments_plus',
          monthlyFee: eur(1900),
          rates: { in_person: 99, online: 250, moto: 295 },
          motoFixedFee: eur(25),
          effectiveFrom: date('2026-09-01'),
          effectiveTo: null,
        },
      ],
      transactions: [],
      vat: vatTreatmentFor(context),
    });

    const invoiceId = nextId();
    await db.transaction().execute((tx) =>
      persistInvoiceDraft(tx, {
        id: invoiceId,
        merchantId,
        subscriptionId,
        legalEntityId: context.legalEntityId,
        draft,
        lineIds: draft.lines.map(() => nextId()),
      }),
    );

    const row = await db
      .selectFrom('invoices')
      .select(['vat_treatment', 'subtotal_minor', 'vat_minor', 'total_minor'])
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();

    return { draft, row };
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('charges German VAT to a German merchant', async () => {
    const { merchantId, subscriptionId } = await merchant('DE', 'DE123456789');

    const { row } = await invoiceFor(merchantId, subscriptionId);

    expect(row.vat_treatment).toBe('standard');
    expect(row.subtotal_minor).toBe(1900);
    expect(row.vat_minor).toBe(361);
    expect(row.total_minor).toBe(2261);
  });

  it('shifts the liability to an Italian merchant with a VAT ID', async () => {
    const { merchantId, subscriptionId } = await merchant('IT', 'IT12345678901');

    const { draft, row } = await invoiceFor(merchantId, subscriptionId);

    expect(row.vat_treatment).toBe('reverse_charge');
    expect(row.vat_minor).toBe(0);
    expect(row.total_minor).toBe(1900);

    // And the ledger has nothing to say about VAT we do not owe.
    expect(
      invoicePostings({
        merchantId,
        subtotal: draft.subtotal,
        vat: draft.vat,
        total: draft.total,
      }).map((posting) => posting.accountKey),
    ).toEqual([`merchant:${merchantId}:wallet`, 'platform:revenue']);
  });

  it('charges Italian VAT to an Italian merchant without one', async () => {
    const { merchantId, subscriptionId } = await merchant('IT', null);

    const { row } = await invoiceFor(merchantId, subscriptionId);

    expect(row.vat_treatment).toBe('standard');
    expect(row.vat_minor).toBe(418); // 22%
  });

  it('puts a British merchant outside the scope rather than under reverse charge', async () => {
    const { merchantId, subscriptionId } = await merchant('GB', 'GB123456789');

    const { row } = await invoiceFor(merchantId, subscriptionId);

    expect(row.vat_treatment).toBe('outside_scope');
    expect(row.vat_minor).toBe(0);
  });
});
