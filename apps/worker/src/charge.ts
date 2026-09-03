import type { Database } from '@billing/db';
import { merchantWalletKey, postTransfer, recordAttempt, settleInvoice } from '@billing/db';
import { money } from '@billing/domain';
import type { IdGenerator, PspClient } from '@billing/platform';
import type { Kysely } from 'kysely';

export interface ChargeDependencies {
  db: Kysely<Database>;
  psp: PspClient;
  ids: IdGenerator;
}

export interface ChargeInvoiceInput {
  invoiceId: string;
  /** Which attempt of the dunning sequence this is. Never counted here. */
  attempt: number;
}

export interface ChargeInvoiceResult {
  status: 'succeeded' | 'failed';
  declineCode?: string;
  /** False when the invoice was already settled and nothing was asked. */
  charged: boolean;
}

/**
 * Collects one invoice, once.
 *
 * The order is deliberate: read, ask the provider, then write. Asking outside a
 * transaction is safe here — unlike the outbox relay, which holds one across
 * its publish — because the request carries a key derived from the invoice and
 * the attempt number. A crash between the charge and the record means the retry
 * asks the same question and is handed the same answer rather than taking the
 * money twice. The unique index on (invoice_id, attempt) closes the other half:
 * the answer cannot be recorded twice either.
 *
 * A provider that cannot be reached throws, and the job is retried by the
 * queue. That is not a decline and must not be recorded as one: nothing is
 * known about the money yet, and a merchant must not lose an attempt to our
 * network.
 */
export async function chargeInvoice(
  deps: ChargeDependencies,
  input: ChargeInvoiceInput,
): Promise<ChargeInvoiceResult> {
  const invoice = await deps.db
    .selectFrom('invoices')
    .select(['id', 'merchant_id', 'status', 'total_minor', 'currency'])
    .where('id', '=', input.invoiceId)
    .executeTakeFirstOrThrow();

  // An earlier attempt may have succeeded while this job sat in the queue.
  // Nothing to collect, and asking again would be a second charge.
  if (invoice.status !== 'open') {
    return { status: invoice.status === 'paid' ? 'succeeded' : 'failed', charged: false };
  }

  const result = await deps.psp.charge({
    idempotencyKey: `invoice:${invoice.id}:attempt:${input.attempt}`,
    amountMinor: invoice.total_minor,
    currency: invoice.currency,
    attempt: input.attempt,
    reference: `invoice:${invoice.id}`,
  });

  const total = money(invoice.total_minor, invoice.currency as 'EUR');
  const attemptId = deps.ids.next();
  const transferId = deps.ids.next();

  await deps.db.transaction().execute(async (tx) => {
    const recorded = await recordAttempt(tx, {
      id: attemptId,
      invoiceId: invoice.id,
      attempt: input.attempt,
      status: result.status,
      declineCode: result.declineCode ?? null,
      pspChargeId: result.id,
      amount: total,
      attemptedAt: new Date(),
    });

    // Already recorded by a delivery of this same job. Its effects are already
    // committed, so repeating them would post the transfer a second time.
    if (!recorded || result.status !== 'succeeded') {
      return;
    }

    await settleInvoice(tx, invoice.id);
    await postTransfer(tx, {
      id: transferId,
      kind: 'invoice_payment',
      occurredAt: new Date(),
      reference: { type: 'invoice', id: invoice.id },
      // The merchant's debt is cleared and the money is in the bank. Signs
      // follow the convention the ledger has used since it was written.
      postings: [
        { accountKey: merchantWalletKey(invoice.merchant_id), amount: total },
        { accountKey: 'platform:bank', amount: money(-total.amount, total.currency) },
      ],
    });
  });

  return {
    status: result.status,
    ...(result.declineCode === undefined ? {} : { declineCode: result.declineCode }),
    charged: true,
  };
}
