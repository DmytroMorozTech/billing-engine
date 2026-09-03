import type { Derivation, InvoiceDraft } from '@billing/domain';
import type { Transaction } from 'kysely';
import type { Temporal } from 'temporal-polyfill';

import { fromPlainDate } from '../mappers.js';
import type { Database } from '../schema.js';
import type { Db } from './subscriptions.js';

export interface PersistInvoiceInput {
  id: string;
  merchantId: string;
  subscriptionId: string;
  legalEntityId: string;
  draft: InvoiceDraft;
  /** One id per draft line, in order. Injected so the write is reproducible. */
  lineIds: readonly string[];
}

export interface StoredInvoiceLine {
  position: number;
  kind: string;
  description: string;
  amountMinor: number;
  derivation: Derivation;
}

/**
 * Writes a draft invoice and its lines.
 *
 * Status is `draft` and `number` stays null: a number is assigned only at
 * finalisation, from `invoice_sequences`, because it has to be gapless and a
 * draft that is later discarded must not consume one. See ADR-0009.
 *
 * The derivation is written as it was produced during the calculation. It is
 * never regenerated on read — an explanation that can drift away from the
 * amount it explains is worse than no explanation, because it still looks
 * authoritative.
 */
export async function persistInvoiceDraft(
  tx: Transaction<Database>,
  input: PersistInvoiceInput,
): Promise<void> {
  const { draft } = input;

  if (input.lineIds.length !== draft.lines.length) {
    throw new RangeError(
      `Need one id per line: ${draft.lines.length} lines, ${input.lineIds.length} ids`,
    );
  }

  await tx
    .insertInto('invoices')
    .values({
      id: input.id,
      merchant_id: input.merchantId,
      subscription_id: input.subscriptionId,
      legal_entity_id: input.legalEntityId,
      number: null,
      status: 'draft',
      period_start: fromPlainDate(draft.period.start),
      period_end: fromPlainDate(draft.period.end),
      currency: draft.currency,
      subtotal_minor: draft.subtotal.amount,
      vat_minor: draft.vat.amount,
      total_minor: draft.total.amount,
      issued_on: null,
      due_on: null,
    })
    .execute();

  if (draft.lines.length === 0) {
    return;
  }

  await tx
    .insertInto('invoice_lines')
    .values(
      draft.lines.map((line, index) => ({
        id: input.lineIds[index] as string,
        invoice_id: input.id,
        position: index,
        kind: line.kind,
        description: line.description,
        amount_minor: line.amount.amount,
        currency: line.amount.currency,
        vat_rate_bps: line.vatRateBps,
        derivation: JSON.stringify(line.derivation),
      })),
    )
    .execute();
}

export interface FinaliseInvoiceInput {
  /** The issue date, in the legal entity's own calendar. Decides the year. */
  issuedOn: Temporal.PlainDate;
  dueOn: Temporal.PlainDate;
}

export class NoSuchInvoiceError extends Error {
  constructor(invoiceId: string) {
    super(`No invoice with id ${invoiceId}`);
    this.name = 'NoSuchInvoiceError';
  }
}

/**
 * Turns a draft into an issued invoice with a number.
 *
 * Takes a `Transaction`, not a `Kysely`, and not by accident: a number handed
 * out by a transaction that later rolls back is precisely the gap the law
 * forbids. The counter row is locked with `SELECT ... FOR UPDATE`, so
 * concurrent finalisations queue rather than collide, and the increment lives
 * or dies with the invoice it numbered. See ADR-0009.
 *
 * The year comes from `issuedOn` rather than from the clock. "Today" for a
 * German entity is a question about Europe/Berlin, and that belongs to the
 * caller who knows which entity is issuing.
 *
 * Finalising an invoice that is already issued returns the number it already
 * has. A retried billing run must not consume a second one.
 */
export async function finaliseInvoice(
  tx: Transaction<Database>,
  invoiceId: string,
  input: FinaliseInvoiceInput,
): Promise<string> {
  const invoice = await tx
    .selectFrom('invoices')
    .select(['legal_entity_id', 'status', 'number'])
    .where('id', '=', invoiceId)
    .executeTakeFirst();

  if (invoice === undefined) {
    throw new NoSuchInvoiceError(invoiceId);
  }
  if (invoice.status !== 'draft' && invoice.number !== null) {
    return invoice.number;
  }

  const number = await claimNextNumber(tx, invoice.legal_entity_id, input.issuedOn.year);

  await tx
    .updateTable('invoices')
    .set({
      number,
      status: 'open',
      issued_on: fromPlainDate(input.issuedOn),
      due_on: fromPlainDate(input.dueOn),
    })
    .where('id', '=', invoiceId)
    .where('status', '=', 'draft')
    .execute();

  return number;
}

/**
 * Takes the next number for a legal entity and year, and advances the counter.
 *
 * The row is created on first use and then locked. `ON CONFLICT DO NOTHING`
 * rather than an upsert with a value: two transactions arriving together must
 * not have one of them silently reset the counter.
 */
async function claimNextNumber(
  tx: Transaction<Database>,
  legalEntityId: string,
  year: number,
): Promise<string> {
  await tx
    .insertInto('invoice_sequences')
    .values({ legal_entity_id: legalEntityId, year, next_value: 1 })
    .onConflict((oc) => oc.columns(['legal_entity_id', 'year']).doNothing())
    .execute();

  const sequence = await tx
    .selectFrom('invoice_sequences')
    .select('next_value')
    .where('legal_entity_id', '=', legalEntityId)
    .where('year', '=', year)
    // Everything after this point is serialised against other finalisations
    // for the same entity and year. That is the cost of gaplessness, and it is
    // paid here rather than by a support engineer explaining a missing number.
    .forUpdate()
    .executeTakeFirstOrThrow();

  await tx
    .updateTable('invoice_sequences')
    .set({ next_value: sequence.next_value + 1 })
    .where('legal_entity_id', '=', legalEntityId)
    .where('year', '=', year)
    .execute();

  const entity = await tx
    .selectFrom('legal_entities')
    .select('number_prefix')
    .where('id', '=', legalEntityId)
    .executeTakeFirstOrThrow();

  return format(entity.number_prefix, year, sequence.next_value);
}

/** `DE-2026-000001`. Padded so numbers sort lexicographically within a year. */
function format(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${value.toString().padStart(6, '0')}`;
}

export async function invoiceLines(db: Db, invoiceId: string): Promise<StoredInvoiceLine[]> {
  const rows = await db
    .selectFrom('invoice_lines')
    .select(['position', 'kind', 'description', 'amount_minor', 'derivation'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('position')
    .execute();

  return rows.map((row) => ({
    position: row.position,
    kind: row.kind,
    description: row.description,
    amountMinor: row.amount_minor,
    derivation: row.derivation as Derivation,
  }));
}

/** True when this subscription already has an invoice covering the period. */
export async function periodAlreadyInvoiced(
  db: Db,
  subscriptionId: string,
  periodStart: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('invoices')
    .select('id')
    .where('subscription_id', '=', subscriptionId)
    .where('period_start', '=', periodStart)
    .where('status', '!=', 'void')
    .executeTakeFirst();

  return row !== undefined;
}
