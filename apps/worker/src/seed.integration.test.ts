import type { Database } from '@billing/db';
import { createDatabase, createPool, migrate, resetSchema, systemTotal } from '@billing/db';
import type { ChargeRequest, ChargeResult, PspClient } from '@billing/platform';
import { SequentialIdGenerator } from '@billing/platform';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedDemoData, type SeededMerchant } from './seed.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_worker_seed';

/** The simulator's rules, without the HTTP hop. */
class RuleBasedPsp implements PspClient {
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    switch (request.amountMinor % 100) {
      case 1:
        return { id: `ch_${request.attempt}`, status: 'failed', declineCode: 'insufficient_funds' };
      case 2:
        return request.attempt >= 3
          ? { id: `ch_${request.attempt}`, status: 'succeeded' }
          : { id: `ch_${request.attempt}`, status: 'failed', declineCode: 'insufficient_funds' };
      default:
        return { id: `ch_${request.attempt}`, status: 'succeeded' };
    }
  }
}

/**
 * The demo data, checked by running it.
 *
 * What is asserted is that each story actually reached the state it exists to
 * show. A seed nobody checks is a demo that breaks in front of an audience,
 * and the failure mode is silent: the rows are there, they just say something
 * duller than intended.
 */
describeIfDatabase('seedDemoData', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let seeded: SeededMerchant[];

  const story = (name: string): SeededMerchant => {
    const found = seeded.find((entry) => entry.story === name);
    if (!found) {
      throw new Error(`No seeded story called ${name}`);
    }
    return found;
  };

  const invoiceOf = (name: string) =>
    db
      .selectFrom('invoices')
      .select(['status', 'number', 'vat_minor', 'vat_treatment', 'total_minor'])
      .where('id', '=', story(name).invoiceId as string)
      .executeTakeFirstOrThrow();

  const subscriptionOf = (name: string) =>
    db
      .selectFrom('subscriptions')
      .select('status')
      .where('id', '=', story(name).subscriptionId)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);

    seeded = await seedDemoData({
      db,
      ids: new SequentialIdGenerator(),
      psp: new RuleBasedPsp(),
    });
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('tells all six stories', () => {
    expect(seeded.map((entry) => entry.story)).toEqual([
      'upgraded-mid-cycle',
      'reverse-charge',
      'outside-scope',
      'into-suspension',
      'recovered',
      'corrected',
    ]);
  });

  it('bills the worked example and collects it', async () => {
    expect(story('upgraded-mid-cycle').totalMinor).toBe(14_071);
    expect(await invoiceOf('upgraded-mid-cycle')).toMatchObject({ status: 'paid' });
    expect(await subscriptionOf('upgraded-mid-cycle')).toEqual({ status: 'active' });
  });

  it('shows both ways an invoice comes to no VAT', async () => {
    expect(await invoiceOf('reverse-charge')).toMatchObject({
      vat_minor: 0,
      vat_treatment: 'reverse_charge',
    });
    expect(await invoiceOf('outside-scope')).toMatchObject({
      vat_minor: 0,
      vat_treatment: 'outside_scope',
    });
  });

  it('leaves one merchant suspended, with the attempts that got them there', async () => {
    expect(await subscriptionOf('into-suspension')).toEqual({ status: 'suspended' });
    expect(await invoiceOf('into-suspension')).toMatchObject({ status: 'uncollectible' });

    const attempts = await db
      .selectFrom('payment_attempts')
      .select(['attempt', 'status', 'decline_code'])
      .where('invoice_id', '=', story('into-suspension').invoiceId as string)
      .orderBy('attempt')
      .execute();

    expect(attempts).toHaveLength(4);
    expect(attempts.every((row) => row.status === 'failed')).toBe(true);
  });

  it('leaves another merchant recovered on the third attempt', async () => {
    expect(await subscriptionOf('recovered')).toEqual({ status: 'active' });
    expect(await invoiceOf('recovered')).toMatchObject({ status: 'paid' });

    const attempts = await db
      .selectFrom('payment_attempts')
      .select(['attempt', 'status'])
      .where('invoice_id', '=', story('recovered').invoiceId as string)
      .orderBy('attempt')
      .execute();

    expect(attempts.map((row) => row.status)).toEqual(['failed', 'failed', 'succeeded']);
  });

  it('gives money back on the corrected merchant', async () => {
    const notes = await db
      .selectFrom('credit_notes')
      .select(['number', 'total_minor'])
      .where('invoice_id', '=', story('corrected').invoiceId as string)
      .execute();

    expect(notes).toHaveLength(1);
    expect(notes[0]?.number).toMatch(/^DE-CN-2026-/);
    expect(notes[0]?.total_minor).toBeLessThan(0);
  });

  it('numbers the invoices in one unbroken run', async () => {
    const numbers = await db
      .selectFrom('invoices')
      .select('number')
      .where('number', 'is not', null)
      .orderBy('number')
      .execute();

    expect(numbers.map((row) => row.number)).toEqual(
      numbers.map((_, index) => `DE-2026-${(index + 1).toString().padStart(6, '0')}`),
    );
  });

  it('leaves the ledger summing to zero, as it must after any sequence', async () => {
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });
});
