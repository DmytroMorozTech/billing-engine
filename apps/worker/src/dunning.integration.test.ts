import type { Database } from '@billing/db';
import {
  balance,
  createDatabase,
  createMerchant,
  createPool,
  createSubscription,
  ensureMerchantAccounts,
  finaliseInvoice,
  invoicePostings,
  merchantWalletKey,
  migrate,
  persistInvoiceDraft,
  postTransfer,
  resetSchema,
  systemTotal,
} from '@billing/db';
import { money, value, type InvoiceDraft } from '@billing/domain';
import type { ChargeRequest, ChargeResult, PspClient } from '@billing/platform';
import { SequentialIdGenerator } from '@billing/platform';
import type { Kysely } from 'kysely';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processDunning } from './dunning.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_worker_dunning';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/** Decides like the simulator does, without the HTTP in between. */
class RuleBasedPsp implements PspClient {
  readonly requests: ChargeRequest[] = [];

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.requests.push(request);

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
 * The sequence, end to end.
 *
 * Runs the whole chain the way the queue will: charge, decide, charge again.
 * No Redis and no waiting — the delay a retry would sit through is returned
 * rather than slept, which is the same trick the virtual clock plays elsewhere
 * in this project and for the same reason.
 */
describeIfDatabase('dunning', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let psp: RuleBasedPsp;
  let ids: SequentialIdGenerator;
  let counter = 0;

  function draft(periodStart: string, totalMinor: number): InvoiceDraft {
    // The subtotal carries the cents that decide the outcome, so the total
    // ends in the digits the provider's rules look at.
    const vat = 0;
    return {
      period: { start: date(periodStart), end: date(periodStart).add({ months: 1 }) },
      currency: 'EUR',
      lines: [
        {
          kind: 'subscription',
          description: 'Subscription',
          amount: eur(totalMinor),
          vatRateBps: 0,
          derivation: {
            result: eur(totalMinor),
            formula: 'monthly fee',
            inputs: [value('fee', eur(totalMinor))],
          },
        },
      ],
      subtotal: eur(totalMinor),
      vat: eur(vat),
      total: eur(totalMinor),
      vatTreatment: 'reverse_charge',
    };
  }

  /** A merchant with one issued, unpaid invoice for the given amount. */
  async function merchantOwing(totalMinor: number) {
    counter += 1;
    const merchantId = ids.next();
    const subscriptionId = ids.next();
    const invoiceId = ids.next();

    await createMerchant(db, {
      id: merchantId,
      legalEntityId: 'de-gmbh',
      marketId: 'IT',
      currency: 'EUR',
      email: `dunning-${counter}@example.com`,
      name: 'Cafe Kreuzberg',
      billingTimeZone: 'Europe/Berlin',
      vatId: 'IT12345678901',
    });
    await createSubscription(db, {
      id: subscriptionId,
      merchantId,
      anchorDate: date('2026-09-01'),
    });
    await ensureMerchantAccounts(db, merchantId, 'EUR');

    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id: invoiceId,
        merchantId,
        subscriptionId,
        legalEntityId: 'de-gmbh',
        draft: draft('2026-09-01', totalMinor),
        lineIds: [ids.next()],
      });
      await finaliseInvoice(tx, invoiceId, {
        issuedOn: date('2026-10-01'),
        dueOn: date('2026-10-15'),
      });
      await postTransfer(tx, {
        id: ids.next(),
        kind: 'invoice_charge',
        occurredAt: new Date(),
        reference: { type: 'invoice', id: invoiceId },
        postings: invoicePostings({
          merchantId,
          subtotal: eur(totalMinor),
          vat: eur(0),
          total: eur(totalMinor),
        }),
      });
    });

    return { merchantId, subscriptionId, invoiceId };
  }

  /** Another open invoice for a merchant who already has one. */
  async function anotherInvoiceFor(
    merchantId: string,
    subscriptionId: string,
    totalMinor: number,
  ): Promise<string> {
    const invoiceId = ids.next();

    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id: invoiceId,
        merchantId,
        subscriptionId,
        legalEntityId: 'de-gmbh',
        draft: draft('2026-10-01', totalMinor),
        lineIds: [ids.next()],
      });
      await finaliseInvoice(tx, invoiceId, {
        issuedOn: date('2026-11-01'),
        dueOn: date('2026-11-15'),
      });
      await postTransfer(tx, {
        id: ids.next(),
        kind: 'invoice_charge',
        occurredAt: new Date(),
        reference: { type: 'invoice', id: invoiceId },
        postings: invoicePostings({
          merchantId,
          subtotal: eur(totalMinor),
          vat: eur(0),
          total: eur(totalMinor),
        }),
      });
    });

    return invoiceId;
  }

  /** Plays the sequence to its end, collecting what happened at each step. */
  async function runToCompletion(invoiceId: string) {
    const steps = [];
    let attempt = 1;

    for (;;) {
      const step = await processDunning({ db, psp, ids }, { invoiceId, attempt });
      steps.push(step);

      if (step.next === null) {
        return steps;
      }
      attempt = step.next.attempt;
    }
  }

  const statuses = async (invoiceId: string, subscriptionId: string) => ({
    invoice: (
      await db.selectFrom('invoices').select('status').where('id', '=', invoiceId).executeTakeFirstOrThrow()
    ).status,
    subscription: (
      await db
        .selectFrom('subscriptions')
        .select('status')
        .where('id', '=', subscriptionId)
        .executeTakeFirstOrThrow()
    ).status,
  });

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
    ids = new SequentialIdGenerator();
  }, 60_000);

  beforeEach(() => {
    psp = new RuleBasedPsp();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('settles on the first attempt when the card works', async () => {
    const { subscriptionId, invoiceId } = await merchantOwing(2200);

    const steps = await runToCompletion(invoiceId);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'succeeded', next: null });
    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'paid',
      subscription: 'active',
    });
  });

  it('recovers when a later attempt goes through', async () => {
    // The case worth having: two declines, then the money arrives. A sequence
    // that could only end in suspension would be a worse system pretending to
    // be a simpler one.
    const { merchantId, subscriptionId, invoiceId } = await merchantOwing(2202);

    const steps = await runToCompletion(invoiceId);

    expect(steps.map((step) => step.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(steps[0]?.next).toMatchObject({ attempt: 2, waitDays: 1 });
    expect(steps[1]?.next).toMatchObject({ attempt: 3, waitDays: 2 });
    expect(steps[2]?.next).toBeNull();

    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'paid',
      // Back to active: being late is not being suspended.
      subscription: 'active',
    });
    expect((await balance(db, merchantWalletKey(merchantId), 'EUR')).amount).toBe(0);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('marks the merchant past due as soon as one attempt fails', async () => {
    const { subscriptionId, invoiceId } = await merchantOwing(2201);

    await processDunning({ db, psp, ids }, { invoiceId, attempt: 1 });

    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'open',
      subscription: 'past_due',
    });
  });

  it('suspends the subscription once the attempts run out', async () => {
    const { subscriptionId, invoiceId } = await merchantOwing(2201);

    const steps = await runToCompletion(invoiceId);

    expect(steps).toHaveLength(4);
    expect(steps.at(-1)).toMatchObject({ status: 'failed', next: null, exhausted: true });
    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'uncollectible',
      subscription: 'suspended',
    });
  });

  it('leaves the debt on the books when it gives up', async () => {
    // Uncollectible is not forgiven. Writing the debt off is a separate
    // decision with its own accounting, not something a failed card triggers.
    const { merchantId, invoiceId } = await merchantOwing(2201);

    await runToCompletion(invoiceId);

    expect((await balance(db, merchantWalletKey(merchantId), 'EUR')).amount).toBe(-2201);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('announces what happened, in order', async () => {
    const { invoiceId } = await merchantOwing(2201);

    await runToCompletion(invoiceId);

    const events = await db
      .selectFrom('outbox')
      .select('event_type')
      .where('aggregate', '=', `invoice:${invoiceId}`)
      .orderBy('id')
      .execute();

    expect(events.map((event) => event.event_type)).toEqual([
      'invoice.finalised',
      'payment.failed',
      'payment.failed',
      'payment.failed',
      'payment.failed',
      'dunning.exhausted',
    ]);
  });

  it('leaves a suspended merchant suspended when a second invoice fails', async () => {
    // A merchant can owe more than one invoice, and they do not run in step.
    // The first exhausts and suspends; the second is still on attempt one.
    // Without the guard on the transition, that second failure would report
    // the merchant as merely past due and the suspension would disappear.
    const { subscriptionId, invoiceId } = await merchantOwing(2201);
    await runToCompletion(invoiceId);

    const second = await anotherInvoiceFor(
      (await db
        .selectFrom('invoices')
        .select('merchant_id')
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow()).merchant_id,
      subscriptionId,
      2201,
    );
    await processDunning({ db, psp, ids }, { invoiceId: second, attempt: 1 });

    expect(await statuses(second, subscriptionId)).toEqual({
      invoice: 'open',
      subscription: 'suspended',
    });
  });

  it('changes nothing when a step arrives after the sequence ended', async () => {
    const { subscriptionId, invoiceId } = await merchantOwing(2201);
    await runToCompletion(invoiceId);

    await processDunning({ db, psp, ids }, { invoiceId, attempt: 2 });

    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'uncollectible',
      subscription: 'suspended',
    });
  });

  it('says nothing more once the sequence is over', async () => {
    // A redelivered step charged nothing, so announcing another failure would
    // be reporting an event that did not happen.
    const { invoiceId } = await merchantOwing(2201);
    await runToCompletion(invoiceId);

    const before = await db
      .selectFrom('outbox')
      .select('id')
      .where('aggregate', '=', `invoice:${invoiceId}`)
      .execute();

    await processDunning({ db, psp, ids }, { invoiceId, attempt: 2 });

    const after = await db
      .selectFrom('outbox')
      .select('id')
      .where('aggregate', '=', `invoice:${invoiceId}`)
      .execute();

    expect(after).toHaveLength(before.length);
  });

  it('does nothing the second time the same step is delivered', async () => {
    const { subscriptionId, invoiceId } = await merchantOwing(2202);
    await runToCompletion(invoiceId);

    // The queue redelivering the first attempt long after the invoice was paid.
    const late = await processDunning({ db, psp, ids }, { invoiceId, attempt: 1 });

    expect(late).toMatchObject({ status: 'succeeded', next: null });
    expect(await statuses(invoiceId, subscriptionId)).toEqual({
      invoice: 'paid',
      subscription: 'active',
    });
  });
});
