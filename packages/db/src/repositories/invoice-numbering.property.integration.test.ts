import { money, value, type InvoiceDraft } from '@billing/domain';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { finaliseInvoice, persistInvoiceDraft } from './invoices.js';
import { createMerchant, createSubscription } from './merchants.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_invoice_numbering_property';

const MERCHANT = '00000000-0000-7000-8000-0000000000b1';
const SUBSCRIPTION = '00000000-0000-7000-8000-0000000000b2';
const YEAR = 2026;

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/** What one billing run does with its invoice: keep it, or fail after numbering. */
interface Attempt {
  commits: boolean;
}

const attempt: fc.Arbitrary<Attempt> = fc.record({ commits: fc.boolean() });

/**
 * Invoice numbers are sequential per legal entity, with no gaps, whatever
 * order the runs finish in and however many of them fail.
 *
 * The concurrency is real: the finalisations in a batch run against separate
 * connections at the same time and contend for the same counter row. The
 * failures are real too — a transaction that throws after taking a number must
 * give it back, which is the property a PostgreSQL sequence cannot offer and
 * the reason ADR-0009 chose a locked row instead.
 */
describeIfDatabase('invoice numbering under concurrency and rollbacks', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;

  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  function draft(periodStart: Temporal.PlainDate): InvoiceDraft {
    return {
      period: { start: periodStart, end: periodStart.add({ months: 1 }) },
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
    };
  }

  /** Periods only have to be distinct here; one per day keeps them so. */
  async function newDraft(index: number): Promise<string> {
    const id = nextId();
    await db.transaction().execute((tx) =>
      persistInvoiceDraft(tx, {
        id,
        merchantId: MERCHANT,
        subscriptionId: SUBSCRIPTION,
        legalEntityId: 'de-gmbh',
        draft: draft(date(`${YEAR}-01-01`).add({ days: index })),
        lineIds: [nextId()],
      }),
    );
    return id;
  }

  async function reset(): Promise<void> {
    await db.deleteFrom('invoice_lines').execute();
    await db.deleteFrom('invoices').execute();
    await db.deleteFrom('invoice_sequences').execute();
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
      email: 'numbering-property@example.com',
      name: 'Cafe Kreuzberg',
      billingTimeZone: 'Europe/Berlin',
    });
    await createSubscription(db, {
      id: SUBSCRIPTION,
      merchantId: MERCHANT,
      anchorDate: date(`${YEAR}-01-01`),
    });
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('never leaves a gap, whatever succeeded and whatever failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(attempt, { minLength: 1, maxLength: 8 }),
        // How many finalisations are in flight at once. 1 is the sequential
        // case; above that they contend for the counter row.
        fc.integer({ min: 1, max: 4 }),
        async (attempts, concurrency) => {
          await reset();

          const drafts = [];
          for (const [index, one] of attempts.entries()) {
            drafts.push({ id: await newDraft(index), commits: one.commits });
          }

          for (let from = 0; from < drafts.length; from += concurrency) {
            await Promise.all(
              drafts.slice(from, from + concurrency).map(async (one) => {
                const run = db.transaction().execute(async (tx) => {
                  await finaliseInvoice(tx, one.id, {
                    issuedOn: date(`${YEAR}-06-01`),
                    dueOn: date(`${YEAR}-06-15`),
                  });
                  if (!one.commits) {
                    throw new Error('run failed after numbering');
                  }
                });

                // A failed billing run is an expected outcome here, not a
                // broken test: what matters is the number it did not keep.
                await run.catch(() => undefined);
              }),
            );
          }

          const issued = await db
            .selectFrom('invoices')
            .select('number')
            .where('number', 'is not', null)
            .orderBy('number')
            .execute();

          const expected = attempts.filter((one) => one.commits).length;
          expect(issued).toHaveLength(expected);
          expect(issued.map((row) => row.number)).toEqual(
            Array.from(
              { length: expected },
              (_, index) => `DE-${YEAR}-${(index + 1).toString().padStart(6, '0')}`,
            ),
          );

          // The counter agrees with what was issued: nothing was reserved and
          // then abandoned.
          const sequence = await db
            .selectFrom('invoice_sequences')
            .select('next_value')
            .where('legal_entity_id', '=', 'de-gmbh')
            .where('year', '=', YEAR)
            .executeTakeFirst();

          expect(sequence?.next_value ?? 1).toBe(expected + 1);
        },
      ),
      // Every run writes real rows through real transactions, so the sample is
      // deliberately small: this is about the shapes, not the volume.
      { numRuns: 12 },
    );
  }, 120_000);
});
