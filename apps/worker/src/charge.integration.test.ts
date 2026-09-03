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

import { chargeInvoice } from './charge.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_worker_charge';
const MERCHANT = '00000000-0000-7000-8000-0000000000c1';
const SUBSCRIPTION = '00000000-0000-7000-8000-0000000000c2';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

/** Answers from a script, and remembers what it was asked. */
class ScriptedPsp implements PspClient {
  readonly requests: ChargeRequest[] = [];
  #answers: ChargeResult[] = [];

  willAnswer(...answers: ChargeResult[]): void {
    this.#answers = [...answers];
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.requests.push(request);
    const answer = this.#answers.shift();
    if (!answer) {
      throw new Error('the scripted provider ran out of answers');
    }
    return answer;
  }
}

const succeeded = (id = 'ch_ok'): ChargeResult => ({ id, status: 'succeeded' });
const declined = (declineCode: string, id = 'ch_no'): ChargeResult => ({
  id,
  status: 'failed',
  declineCode,
});

/**
 * Collecting one invoice.
 *
 * The provider is scripted here rather than reached over HTTP: what these tests
 * are about is what the database is left holding afterwards, and a real
 * provider would only make the outcomes harder to arrange. The transport itself
 * is tested against the running simulator in `psp-client`.
 */
describeIfDatabase('chargeInvoice', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let psp: ScriptedPsp;
  let ids: SequentialIdGenerator;
  let counter = 0;

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
          derivation: { result: eur(1900), formula: 'monthly fee', inputs: [value('fee', eur(1900))] },
        },
      ],
      subtotal: eur(1900),
      vat: eur(361),
      total: eur(2261),
      vatTreatment: 'standard',
    };
  }

  /** An issued invoice, ready to be collected. */
  async function issuedInvoice(): Promise<string> {
    counter += 1;
    const id = `00000000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;

    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id,
        merchantId: MERCHANT,
        subscriptionId: SUBSCRIPTION,
        legalEntityId: 'de-gmbh',
        draft: draft(`2026-${counter.toString().padStart(2, '0')}-01`),
        lineIds: [ids.next()],
      });
      await finaliseInvoice(tx, id, { issuedOn: date('2026-10-01'), dueOn: date('2026-10-15') });
      await postTransfer(tx, {
        id: ids.next(),
        kind: 'invoice_charge',
        occurredAt: new Date(),
        reference: { type: 'invoice', id },
        postings: invoicePostings({
          merchantId: MERCHANT,
          subtotal: eur(1900),
          vat: eur(361),
          total: eur(2261),
        }),
      });
    });

    return id;
  }

  const invoiceStatus = async (id: string) =>
    (
      await db
        .selectFrom('invoices')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  const attempts = (invoiceId: string) =>
    db
      .selectFrom('payment_attempts')
      .select(['attempt', 'status', 'decline_code', 'psp_charge_id', 'amount_minor'])
      .where('invoice_id', '=', invoiceId)
      .orderBy('attempt')
      .execute();

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
    ids = new SequentialIdGenerator();

    await createMerchant(db, {
      id: MERCHANT,
      legalEntityId: 'de-gmbh',
      marketId: 'DE',
      currency: 'EUR',
      email: 'charge@example.com',
      name: 'Cafe Kreuzberg',
      billingTimeZone: 'Europe/Berlin',
    });
    await createSubscription(db, {
      id: SUBSCRIPTION,
      merchantId: MERCHANT,
      anchorDate: date('2026-01-01'),
    });
    await ensureMerchantAccounts(db, MERCHANT, 'EUR');
  }, 60_000);

  beforeEach(() => {
    psp = new ScriptedPsp();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('settles the invoice and moves the money when the charge goes through', async () => {
    const owedBefore = await balance(db, merchantWalletKey(MERCHANT), 'EUR');
    const invoiceId = await issuedInvoice();
    psp.willAnswer(succeeded('ch_paid'));

    const result = await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 1 });

    expect(result.status).toBe('succeeded');
    expect(await invoiceStatus(invoiceId)).toBe('paid');
    expect(await attempts(invoiceId)).toEqual([
      {
        attempt: 1,
        status: 'succeeded',
        decline_code: null,
        psp_charge_id: 'ch_paid',
        amount_minor: 2261,
      },
    ]);

    // The merchant is back where they started - the invoice put them 2261 in
    // debt and the payment cleared exactly that - and the money is in the bank.
    expect((await balance(db, merchantWalletKey(MERCHANT), 'EUR')).amount).toBe(owedBefore.amount);
    expect((await balance(db, 'platform:bank', 'EUR')).amount).toBe(-2261);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('records the decline and leaves the invoice open', async () => {
    const invoiceId = await issuedInvoice();
    const before = await systemTotal(db, 'EUR');
    psp.willAnswer(declined('insufficient_funds', 'ch_declined'));

    const result = await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 1 });

    expect(result).toMatchObject({ status: 'failed', declineCode: 'insufficient_funds' });
    expect(await invoiceStatus(invoiceId)).toBe('open');
    expect(await attempts(invoiceId)).toMatchObject([
      { attempt: 1, status: 'failed', decline_code: 'insufficient_funds' },
    ]);

    // A payment that did not happen moved no money.
    expect((await systemTotal(db, 'EUR')).amount).toBe(before.amount);
    const wallet = await balance(db, merchantWalletKey(MERCHANT), 'EUR');
    expect(wallet.amount).toBe(-2261);
  });

  it('asks the provider with a key it can derive again', async () => {
    const invoiceId = await issuedInvoice();
    psp.willAnswer(succeeded());

    await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 3 });

    expect(psp.requests[0]).toMatchObject({
      idempotencyKey: `invoice:${invoiceId}:attempt:3`,
      amountMinor: 2261,
      currency: 'EUR',
      attempt: 3,
    });
  });

  it('does not charge twice when the same job is delivered twice', async () => {
    // At-least-once delivery is the promise, so this happens in normal
    // operation, not only after a crash.
    const invoiceId = await issuedInvoice();
    psp.willAnswer(succeeded('ch_once'), succeeded('ch_once'));

    await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 1 });
    const second = await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 1 });

    expect(second.status).toBe('succeeded');
    expect(await attempts(invoiceId)).toHaveLength(1);

    // One payment, not two. Counted against this invoice rather than read off a
    // balance, which the other tests in this file also move.
    const payments = await db
      .selectFrom('ledger_transfers')
      .select('id')
      .where('kind', '=', 'invoice_payment')
      .where('reference_id', '=', invoiceId)
      .execute();
    expect(payments).toHaveLength(1);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('will not collect an invoice that is already paid', async () => {
    const invoiceId = await issuedInvoice();
    psp.willAnswer(succeeded('ch_first'));
    await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 1 });

    // A retry scheduled before the earlier attempt succeeded, arriving after.
    const late = await chargeInvoice({ db, psp, ids }, { invoiceId, attempt: 2 });

    expect(late.status).toBe('succeeded');
    expect(psp.requests).toHaveLength(1);
    expect(await attempts(invoiceId)).toHaveLength(1);
  });
});
