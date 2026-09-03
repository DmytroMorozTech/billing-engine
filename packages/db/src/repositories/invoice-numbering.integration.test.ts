import { money, value, type InvoiceDraft } from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { finaliseInvoice, NoSuchInvoiceError, persistInvoiceDraft } from './invoices.js';
import { createMerchant, createSubscription } from './merchants.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

/** Own schema, for the same reason as the other integration files. */
const SCHEMA = 'test_invoice_numbering';

const MERCHANT = '00000000-0000-7000-8000-0000000000d1';
const SUBSCRIPTION = '00000000-0000-7000-8000-0000000000d2';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/**
 * Gapless invoice numbering.
 *
 * German and Italian law require invoice numbers without gaps, which is why the
 * counter is an ordinary row rather than a PostgreSQL sequence: a sequence is
 * non-transactional and a rolled-back transaction burns its number. These tests
 * exist to prove the difference, so they run against the real database — the
 * behaviour being asserted is the database's, not the code's.
 */
describeIfDatabase('invoice numbering', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;

  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  /** A draft with one line, since numbering does not care what is on it. */
  function draft(periodStart: string): InvoiceDraft {
    return {
      period: { start: date(periodStart), end: date(periodStart).add({ months: 1 }) },
      currency: 'EUR',
      lines: [
        {
          kind: 'subscription',
          description: 'Subscription',
          amount: eur(1900),
          vatRateBps: 1900,
          derivation: {
            result: eur(1900),
            formula: 'monthly fee',
            inputs: [value('fee', eur(1900))],
          },
        },
      ],
      subtotal: eur(1900),
      vat: eur(361),
      total: eur(2261),
      vatTreatment: 'standard',
    };
  }

  /** Persists a draft and returns its id. Each gets its own period. */
  async function newDraft(periodStart: string): Promise<string> {
    const id = nextId();
    await db.transaction().execute((tx) =>
      persistInvoiceDraft(tx, {
        id,
        merchantId: MERCHANT,
        subscriptionId: SUBSCRIPTION,
        legalEntityId: 'de-gmbh',
        draft: draft(periodStart),
        lineIds: [nextId()],
      }),
    );
    return id;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);

    await createMerchant(db, {
      id: MERCHANT,
      legalEntityId: 'de-gmbh',
      marketId: 'DE',
      currency: 'EUR',
      email: 'numbering@example.com',
      name: 'Cafe Kreuzberg',
      billingTimeZone: 'Europe/Berlin',
    });
    await createSubscription(db, {
      id: SUBSCRIPTION,
      merchantId: MERCHANT,
      anchorDate: date('2026-01-01'),
    });
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('issues the first number of the year and opens the invoice', async () => {
    const invoiceId = await newDraft('2026-01-01');

    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, invoiceId, { issuedOn: date('2026-02-01'), dueOn: date('2026-02-15') }),
      );

    expect(number).toBe('DE-2026-000001');

    const invoice = await db
      .selectFrom('invoices')
      .select(['number', 'status', 'issued_on', 'due_on'])
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow();

    expect(invoice).toEqual({
      number: 'DE-2026-000001',
      status: 'open',
      issued_on: '2026-02-01',
      due_on: '2026-02-15',
    });
  });

  it('hands the next invoice the next number', async () => {
    const invoiceId = await newDraft('2026-02-01');

    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, invoiceId, { issuedOn: date('2026-03-01'), dueOn: date('2026-03-15') }),
      );

    expect(number).toBe('DE-2026-000002');
  });

  it('starts again at one in a new year', async () => {
    const invoiceId = await newDraft('2027-01-01');

    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, invoiceId, { issuedOn: date('2027-02-01'), dueOn: date('2027-02-15') }),
      );

    // The counter is keyed by (legal entity, year), so 2026 keeps its own run.
    expect(number).toBe('DE-2027-000001');
  });

  it('does not spend a second number on a re-finalised invoice', async () => {
    const invoiceId = await newDraft('2026-03-01');
    const finalise = () =>
      db
        .transaction()
        .execute((tx) =>
          finaliseInvoice(tx, invoiceId, {
            issuedOn: date('2026-04-01'),
            dueOn: date('2026-04-15'),
          }),
        );

    const first = await finalise();
    const retry = await finalise();

    expect(retry).toBe(first);

    // The proof that no number was burned: the next invoice takes the one
    // immediately after, not one further on.
    const nextId2 = await newDraft('2026-04-01');
    const next = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, nextId2, { issuedOn: date('2026-05-01'), dueOn: date('2026-05-15') }),
      );

    expect(next).toBe(bump(first));
  });

  it('leaves no gap when the transaction that took a number rolls back', async () => {
    // This is the entire reason the counter is a row and not a SEQUENCE. A
    // sequence would have burned the number here and left a hole in the books.
    const doomed = await newDraft('2026-05-01');

    await expect(
      db.transaction().execute(async (tx) => {
        await finaliseInvoice(tx, doomed, {
          issuedOn: date('2026-06-01'),
          dueOn: date('2026-06-15'),
        });
        throw new Error('billing run failed after numbering');
      }),
    ).rejects.toThrow('billing run failed after numbering');

    const survivor = await newDraft('2026-06-01');
    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, survivor, { issuedOn: date('2026-07-01'), dueOn: date('2026-07-15') }),
      );

    const issued = await db
      .selectFrom('invoices')
      .select('number')
      .where('number', 'is not', null)
      .where('number', 'like', 'DE-2026-%')
      .orderBy('number')
      .execute();

    expect(issued.map((row) => row.number)).toEqual(sequential(issued.length));
    expect(number).toBe(issued.at(-1)?.number);

    // And the rolled-back invoice is still a draft, with no number at all.
    const rolledBack = await db
      .selectFrom('invoices')
      .select(['status', 'number'])
      .where('id', '=', doomed)
      .executeTakeFirstOrThrow();
    expect(rolledBack).toEqual({ status: 'draft', number: null });
  });

  it('announces the issued invoice in the same transaction', async () => {
    const invoiceId = await newDraft('2026-08-01');

    const number = await db
      .transaction()
      .execute((tx) =>
        finaliseInvoice(tx, invoiceId, { issuedOn: date('2026-09-01'), dueOn: date('2026-09-15') }),
      );

    const events = await db
      .selectFrom('outbox')
      .select(['aggregate', 'event_type', 'payload'])
      .where('aggregate', '=', `invoice:${invoiceId}`)
      .execute();

    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('invoice.finalised');
    expect(events[0]?.payload).toMatchObject({
      invoiceId,
      number,
      // What a dunning schedule needs to know without reading the invoice back.
      dueOn: '2026-09-15',
      totalMinor: 2261,
      currency: 'EUR',
    });
  });

  it('announces nothing when the run that issued the invoice rolls back', async () => {
    // The pair ADR-0005 is about: the number and the announcement of it are one
    // decision, so they survive together or not at all.
    const doomed = await newDraft('2026-09-01');

    await expect(
      db.transaction().execute(async (tx) => {
        await finaliseInvoice(tx, doomed, {
          issuedOn: date('2026-10-01'),
          dueOn: date('2026-10-15'),
        });
        throw new Error('the billing run failed after announcing');
      }),
    ).rejects.toThrow('failed after announcing');

    const events = await db
      .selectFrom('outbox')
      .select('id')
      .where('aggregate', '=', `invoice:${doomed}`)
      .execute();

    expect(events).toEqual([]);
  });

  it('refuses to number an invoice that does not exist', async () => {
    await expect(
      db.transaction().execute((tx) =>
        finaliseInvoice(tx, '00000000-0000-7000-8000-0000000000ff', {
          issuedOn: date('2026-02-01'),
          dueOn: date('2026-02-15'),
        }),
      ),
    ).rejects.toThrow(NoSuchInvoiceError);
  });
});

/** `DE-2026-000004` → `DE-2026-000005`. */
function bump(number: string): string {
  const [prefix, year, counter] = number.split('-') as [string, string, string];
  return `${prefix}-${year}-${(Number(counter) + 1).toString().padStart(6, '0')}`;
}

/** The numbers a gapless run of `count` invoices must have. */
function sequential(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `DE-2026-${(index + 1).toString().padStart(6, '0')}`,
  );
}
