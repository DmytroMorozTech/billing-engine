import type { Money } from '@billing/domain';
import type { Transaction } from 'kysely';

import type { Database } from '../schema.js';
import type { Db } from './subscriptions.js';

export interface NewPaymentAttempt {
  id: string;
  invoiceId: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  declineCode: string | null;
  pspChargeId: string;
  amount: Money;
  attemptedAt: Date;
}

export interface PaymentAttempt {
  attempt: number;
  status: 'succeeded' | 'failed';
  declineCode: string | null;
  pspChargeId: string;
  attemptedAt: Date;
}

/**
 * Records what the provider answered.
 *
 * Returns false when this attempt was already recorded, which is not an error:
 * the queue delivers at least once, so the same attempt arrives twice in normal
 * operation. The caller uses the answer to decide whether the effects still
 * need applying, rather than applying them a second time.
 */
export async function recordAttempt(
  tx: Transaction<Database>,
  input: NewPaymentAttempt,
): Promise<boolean> {
  const inserted = await tx
    .insertInto('payment_attempts')
    .values({
      id: input.id,
      invoice_id: input.invoiceId,
      attempt: input.attempt,
      status: input.status,
      decline_code: input.declineCode,
      psp_charge_id: input.pspChargeId,
      amount_minor: input.amount.amount,
      currency: input.amount.currency,
      attempted_at: input.attemptedAt,
    })
    .onConflict((oc) => oc.columns(['invoice_id', 'attempt']).doNothing())
    .executeTakeFirst();

  return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/** Every attempt against an invoice, oldest first. The dunning history. */
export async function attemptsFor(db: Db, invoiceId: string): Promise<PaymentAttempt[]> {
  const rows = await db
    .selectFrom('payment_attempts')
    .select(['attempt', 'status', 'decline_code', 'psp_charge_id', 'attempted_at'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('attempt')
    .execute();

  return rows.map((row) => ({
    attempt: row.attempt,
    status: row.status,
    declineCode: row.decline_code,
    pspChargeId: row.psp_charge_id,
    attemptedAt: row.attempted_at,
  }));
}

/**
 * Marks an invoice paid.
 *
 * Guarded on `open` so that a late duplicate cannot move an invoice out of
 * `uncollectible` or back from `void`. Settling is a one-way step.
 */
export async function settleInvoice(
  tx: Transaction<Database>,
  invoiceId: string,
): Promise<void> {
  await tx
    .updateTable('invoices')
    .set({ status: 'paid' })
    .where('id', '=', invoiceId)
    .where('status', '=', 'open')
    .execute();
}
