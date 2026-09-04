import type { CreditNoteDraft, Money } from '@billing/domain';
import { money } from '@billing/domain';
import { sql, type Transaction } from 'kysely';
import type { Temporal } from 'temporal-polyfill';

import { fromPlainDate } from '../mappers.js';
import type { Database } from '../schema.js';
import { claimNextNumber } from './invoices.js';
import { invoicePostings, postTransfer } from './ledger.js';
import { enqueue } from './outbox.js';
import type { Db } from './subscriptions.js';

export interface IssueCreditNoteInput {
  id: string;
  merchantId: string;
  /** The invoice being corrected. */
  invoiceId: string;
  legalEntityId: string;
  draft: CreditNoteDraft;
  /** One id per draft line, in order. Injected so the write is reproducible. */
  lineIds: readonly string[];
  /** Id for the reversing ledger transfer. */
  transferId: string;
  issuedOn: Temporal.PlainDate;
}

/**
 * Issues a credit note: the document, its lines, the reversal and the event.
 *
 * All four in one transaction, and deliberately not split into steps a caller
 * composes. A credit note without its reversing transfer is a promise on paper
 * that the ledger does not know about, and a reversal without the document is
 * money moving for no stated reason. Neither half is meaningful alone, so
 * neither half can be committed alone.
 *
 * The number comes from the credit-note series, which is gapless in its own
 * right — see ADR-0009 for why the counter is a locked row rather than a
 * sequence.
 */
export async function issueCreditNote(
  tx: Transaction<Database>,
  input: IssueCreditNoteInput,
): Promise<string> {
  const { draft } = input;

  if (input.lineIds.length !== draft.lines.length) {
    throw new RangeError(
      `Need one id per line: ${draft.lines.length} lines, ${input.lineIds.length} ids`,
    );
  }
  if (draft.total.amount >= 0) {
    throw new RangeError(
      `A credit note returns money, so its total must be negative; received ${draft.total.amount}`,
    );
  }

  const number = await claimNextNumber(
    tx,
    input.legalEntityId,
    'credit_note',
    input.issuedOn.year,
  );

  await tx
    .insertInto('credit_notes')
    .values({
      id: input.id,
      merchant_id: input.merchantId,
      invoice_id: input.invoiceId,
      legal_entity_id: input.legalEntityId,
      number,
      currency: draft.currency,
      subtotal_minor: draft.subtotal.amount,
      vat_minor: draft.vat.amount,
      total_minor: draft.total.amount,
      vat_treatment: draft.vatTreatment,
      issued_on: fromPlainDate(input.issuedOn),
    })
    .execute();

  if (draft.lines.length > 0) {
    await tx
      .insertInto('credit_note_lines')
      .values(
        draft.lines.map((line, index) => ({
          id: input.lineIds[index] as string,
          credit_note_id: input.id,
          position: index,
          kind: line.kind === 'adjustment' ? ('adjustment' as const) : ('proration_credit' as const),
          description: line.description,
          amount_minor: line.amount.amount,
          currency: line.amount.currency,
          vat_rate_bps: line.vatRateBps,
          derivation: JSON.stringify(line.derivation),
        })),
      )
      .execute();
  }

  // The same postings the invoice made, with the signs the other way round.
  // `invoicePostings` takes them as given precisely so a correction needs no
  // second function that could disagree with the first.
  await postTransfer(tx, {
    id: input.transferId,
    kind: 'credit_note',
    occurredAt: new Date(),
    reference: { type: 'credit_note', id: input.id },
    postings: invoicePostings({
      merchantId: input.merchantId,
      subtotal: draft.subtotal,
      vat: draft.vat,
      total: draft.total,
    }),
  });

  await enqueue(tx, {
    aggregate: `invoice:${input.invoiceId}`,
    eventType: 'credit_note.issued',
    payload: {
      creditNoteId: input.id,
      invoiceId: input.invoiceId,
      merchantId: input.merchantId,
      number,
      totalMinor: draft.total.amount,
      currency: draft.currency,
    },
  });

  return number;
}

/**
 * What is still charged for an invoice, after any credit notes already issued
 * against it.
 *
 * The number a further correction has to be measured against. Comparing a
 * recomputed period with the invoice's original total instead would credit the
 * same money twice the second time a merchant's timeline is corrected — which
 * is not a hypothetical: a support engineer who fixes a date and then fixes it
 * again is the ordinary case.
 */
export async function netCharged(db: Db, invoiceId: string): Promise<{
  subtotal: Money;
  vat: Money;
  total: Money;
}> {
  const invoice = await db
    .selectFrom('invoices')
    .select(['currency', 'subtotal_minor', 'vat_minor', 'total_minor'])
    .where('id', '=', invoiceId)
    .executeTakeFirstOrThrow();

  // Cast back to BIGINT: PostgreSQL widens SUM over a bigint to NUMERIC, and
  // the driver's NUMERIC parser throws on purpose (ADR-0001). Same treatment
  // as the ledger balance, and for the same reason — the guard stays armed
  // rather than being relaxed for one query.
  const credited = await db
    .selectFrom('credit_notes')
    .select([
      sql<number>`COALESCE(SUM(subtotal_minor), 0)::bigint`.as('subtotal'),
      sql<number>`COALESCE(SUM(vat_minor), 0)::bigint`.as('vat'),
      sql<number>`COALESCE(SUM(total_minor), 0)::bigint`.as('total'),
    ])
    .where('invoice_id', '=', invoiceId)
    .executeTakeFirst();

  const currency = invoice.currency as 'EUR';
  const sum = (charged: number, credit: unknown) => money(charged + Number(credit ?? 0), currency);

  return {
    subtotal: sum(invoice.subtotal_minor, credited?.subtotal),
    vat: sum(invoice.vat_minor, credited?.vat),
    total: sum(invoice.total_minor, credited?.total),
  };
}

export interface StoredCreditNote {
  id: string;
  number: string;
  invoiceId: string;
  totalMinor: number;
  issuedOn: string;
}

/** Every credit note against an invoice, oldest first. */
export async function creditNotesFor(db: Db, invoiceId: string): Promise<StoredCreditNote[]> {
  const rows = await db
    .selectFrom('credit_notes')
    .select(['id', 'number', 'invoice_id', 'total_minor', 'issued_on'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('number')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    invoiceId: row.invoice_id,
    totalMinor: row.total_minor,
    issuedOn: row.issued_on,
  }));
}
