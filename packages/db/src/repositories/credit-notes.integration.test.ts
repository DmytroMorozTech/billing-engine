import { buildInvoice, money, prepareCorrection, value, type InvoiceDraft } from '@billing/domain';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { creditNotesFor, issueCreditNote, netCharged } from './credit-notes.js';
import { finaliseInvoice, persistInvoiceDraft } from './invoices.js';
import { balance, ensureMerchantAccounts, invoicePostings, merchantWalletKey, postTransfer, systemTotal } from './ledger.js';
import { createMerchant, createSubscription } from './merchants.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_credit_notes';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');
const PERIOD = { start: date('2026-09-01'), end: date('2026-10-01') };

/**
 * Giving money back after a backdated change.
 *
 * The arithmetic is proven in the domain. What is proven here is the part that
 * only a database can be wrong about: that the document, its number, its lines
 * and the reversing transfer arrive together, and that correcting the same
 * period twice does not return the same money twice.
 */
describeIfDatabase('credit notes', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;

  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  /** The timeline with the upgrade falling on the given day of September. */
  function intervals(day: number) {
    const change = date(`2026-09-${day.toString().padStart(2, '0')}`);
    return [
      {
        id: 'ri_standard',
        planId: 'standard',
        monthlyFee: eur(0),
        rates: { in_person: 169, online: 250, moto: 295 },
        motoFixedFee: eur(25),
        effectiveFrom: date('2026-01-31'),
        effectiveTo: change,
      },
      {
        id: 'ri_plus',
        planId: 'payments_plus',
        monthlyFee: eur(1900),
        rates: { in_person: 99, online: 250, moto: 295 },
        motoFixedFee: eur(25),
        effectiveFrom: change,
        effectiveTo: null,
      },
    ];
  }

  const transactions = [
    // Placed either side of the dates the corrections move through, so that
    // moving the upgrade earlier actually re-rates volume rather than only
    // shifting the prorated fee.
    { id: 't1', gross: eur(413_000), channel: 'in_person' as const, occurredOn: date('2026-09-08') },
    { id: 't2', gross: eur(387_000), channel: 'in_person' as const, occurredOn: date('2026-09-18') },
  ];

  const invoiceFor = (day: number): InvoiceDraft =>
    buildInvoice({
      period: PERIOD,
      currency: 'EUR',
      intervals: intervals(day),
      transactions,
      vat: { kind: 'standard', rateBps: 1900 },
    });

  /**
   * An issued invoice for the period, charged to the merchant's wallet.
   *
   * Each gets its own subscription: only one invoice may exist per subscription
   * and period, which is the billing run's own idempotency and not something to
   * work around here.
   */
  async function issuedInvoice(
    day: number,
  ): Promise<{ id: string; draft: InvoiceDraft; merchantId: string }> {
    const id = nextId();
    const merchantId = nextId();
    const subscriptionId = nextId();
    const draft = invoiceFor(day);

    await createMerchant(db, {
      id: merchantId,
      legalEntityId: 'de-gmbh',
      marketId: 'DE',
      currency: 'EUR',
      email: `credit-${merchantId}@example.com`,
      name: 'Cafe Kreuzberg',
      billingTimeZone: 'Europe/Berlin',
    });
    await createSubscription(db, {
      id: subscriptionId,
      merchantId,
      anchorDate: date('2026-09-01'),
    });
    await ensureMerchantAccounts(db, merchantId, 'EUR');

    await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id,
        merchantId,
        subscriptionId,
        legalEntityId: 'de-gmbh',
        draft,
        lineIds: draft.lines.map(() => nextId()),
      });
      await finaliseInvoice(tx, id, { issuedOn: date('2026-10-01'), dueOn: date('2026-10-15') });
      await postTransfer(tx, {
        id: nextId(),
        kind: 'invoice_charge',
        occurredAt: new Date(),
        reference: { type: 'invoice', id },
        postings: invoicePostings({
          merchantId,
          subtotal: draft.subtotal,
          vat: draft.vat,
          total: draft.total,
        }),
      });
    });

    return { id, draft, merchantId };
  }

  /** Corrects an issued invoice to the timeline with the upgrade on `day`. */
  async function correctTo(invoiceId: string, merchantId: string, day: number) {
    const charged = await netCharged(db, invoiceId);
    const correction = prepareCorrection({
      period: PERIOD,
      issued: charged,
      recomputed: invoiceFor(day),
    });

    if (correction.kind !== 'credit') {
      return { correction, number: null };
    }

    const number = await db.transaction().execute((tx) =>
      issueCreditNote(tx, {
        id: nextId(),
        merchantId,
        invoiceId,
        legalEntityId: 'de-gmbh',
        draft: correction.draft,
        lineIds: correction.draft.lines.map(() => nextId()),
        transferId: nextId(),
        issuedOn: date('2026-10-05'),
      }),
    );

    return { correction, number };
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

  it('credits the difference and numbers it in its own series', async () => {
    const invoice = await issuedInvoice(15);
    expect(invoice.draft.total.amount).toBe(14_071);

    const { correction, number } = await correctTo(invoice.id, invoice.merchantId, 5);

    // The worked example, all the way through the database.
    expect(number).toBe('DE-CN-2026-000001');
    if (correction.kind !== 'credit') {
      throw new Error('expected a credit');
    }
    expect(correction.draft.total.amount).toBe(-2686);

    const stored = await creditNotesFor(db, invoice.id);
    expect(stored).toMatchObject([{ number: 'DE-CN-2026-000001', totalMinor: -2686 }]);
  });

  it('moves the money back and leaves the ledger balanced', async () => {
    const invoice = await issuedInvoice(15);

    await correctTo(invoice.id, invoice.merchantId, 5);

    // Charged 14071 by the invoice, given 2686 back: 11385 still owed.
    const wallet = await balance(db, merchantWalletKey(invoice.merchantId), 'EUR');
    expect(wallet.amount).toBe(-11_385);
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  });

  it('does not return the same money twice when a period is corrected again', async () => {
    // A support engineer fixes the date, then fixes it again. The second
    // correction is measured against what is still charged, not against the
    // invoice's original total.
    // 20th → 16918, 15th → 14071, 5th → 11385: each move re-rates a
    // transaction onto the cheaper plan, so both corrections are credits.
    const invoice = await issuedInvoice(20);
    expect(invoice.draft.total.amount).toBe(16_918);

    const first = await correctTo(invoice.id, invoice.merchantId, 15);
    const second = await correctTo(invoice.id, invoice.merchantId, 5);

    expect(first.number).not.toBeNull();
    expect(second.number).not.toBeNull();

    const notes = await creditNotesFor(db, invoice.id);
    const credited = notes.reduce((total, note) => total + note.totalMinor, 0);

    // Two credit notes, and together they return exactly the difference
    // between what was invoiced and what the period finally comes to.
    expect(notes).toHaveLength(2);
    expect(16_918 + credited).toBe(invoiceFor(5).total.amount);
    expect((await netCharged(db, invoice.id)).total.amount).toBe(invoiceFor(5).total.amount);
  });

  it('has nothing to credit when the timeline is corrected back to where it was', async () => {
    const invoice = await issuedInvoice(15);
    await correctTo(invoice.id, invoice.merchantId, 5);

    const again = await correctTo(invoice.id, invoice.merchantId, 5);

    expect(again.correction.kind).toBe('none');
    expect(await creditNotesFor(db, invoice.id)).toHaveLength(1);
  });

  it('refuses a credit note that would take money rather than give it', async () => {
    const invoice = await issuedInvoice(15);

    await expect(
      db.transaction().execute((tx) =>
        issueCreditNote(tx, {
          id: nextId(),
          merchantId: invoice.merchantId,
          invoiceId: invoice.id,
          legalEntityId: 'de-gmbh',
          draft: {
            period: PERIOD,
            currency: 'EUR',
            lines: [
              {
                kind: 'proration_credit',
                description: 'wrong way round',
                amount: eur(100),
                vatRateBps: 1900,
                derivation: { result: eur(100), formula: 'nonsense', inputs: [value('x', eur(100))] },
              },
            ],
            subtotal: eur(100),
            vat: eur(19),
            total: eur(119),
            vatTreatment: 'standard',
          },
          lineIds: [nextId()],
          transferId: nextId(),
          issuedOn: date('2026-10-05'),
        }),
      ),
    ).rejects.toThrow(/must be negative/);
  });

  it('announces the credit note', async () => {
    const invoice = await issuedInvoice(15);
    await correctTo(invoice.id, invoice.merchantId, 5);

    const events = await db
      .selectFrom('outbox')
      .select(['event_type', 'payload'])
      .where('aggregate', '=', `invoice:${invoice.id}`)
      .orderBy('id')
      .execute();

    expect(events.map((event) => event.event_type)).toEqual([
      'invoice.finalised',
      'credit_note.issued',
    ]);
    expect(events[1]?.payload).toMatchObject({ totalMinor: -2686, currency: 'EUR' });
  });
});
