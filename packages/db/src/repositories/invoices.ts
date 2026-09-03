import type { Derivation, InvoiceDraft } from '@billing/domain';
import type { Transaction } from 'kysely';

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
