import type { BillingPeriod, Channel, Money, RatedTransaction } from '@billing/domain';
import type { Temporal } from 'temporal-polyfill';

import { fromPlainDate, toMoney, toPlainDate } from '../mappers.js';
import type { Db } from './subscriptions.js';

export interface IngestTransactionInput {
  id: string;
  merchantId: string;
  gross: Money;
  channel: Channel;
  /** The instant the payment happened. */
  occurredAt: Temporal.Instant;
}

/**
 * Records processed volume.
 *
 * `occurred_on` — the local calendar date the transaction is rated against — is
 * computed here from the merchant's billing time zone and then frozen forever.
 * A merchant who later changes zone does not retroactively move transactions
 * that have already been invoiced; the new zone applies from the change onward.
 * See ADR-0009.
 */
export async function ingestTransaction(
  db: Db,
  input: IngestTransactionInput,
  billingTimeZone: string,
): Promise<Temporal.PlainDate> {
  const occurredOn = input.occurredAt.toZonedDateTimeISO(billingTimeZone).toPlainDate();

  await db
    .insertInto('transactions')
    .values({
      id: input.id,
      merchant_id: input.merchantId,
      gross_minor: input.gross.amount,
      currency: input.gross.currency,
      channel: input.channel,
      occurred_at: new Date(input.occurredAt.epochMilliseconds),
      occurred_on: fromPlainDate(occurredOn),
      invoiced_by: null,
    })
    .execute();

  return occurredOn;
}

/**
 * Transactions in a period that have not been billed yet.
 *
 * Filtering on `invoiced_by IS NULL` is what makes a repeated billing run a
 * no-op rather than a second charge. The unique index on
 * (subscription_id, period_start) is the belt to this pair of braces.
 */
export async function uninvoicedInPeriod(
  db: Db,
  merchantId: string,
  period: BillingPeriod,
): Promise<RatedTransaction[]> {
  const rows = await db
    .selectFrom('transactions')
    .select(['id', 'gross_minor', 'currency', 'channel', 'occurred_on'])
    .where('merchant_id', '=', merchantId)
    .where('invoiced_by', 'is', null)
    .where('occurred_on', '>=', fromPlainDate(period.start))
    .where('occurred_on', '<', fromPlainDate(period.end))
    .orderBy('occurred_on')
    .orderBy('id')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    gross: toMoney(row.gross_minor, row.currency),
    channel: row.channel,
    occurredOn: toPlainDate(row.occurred_on),
  }));
}

/** Marks transactions as billed by an invoice. */
export async function markInvoiced(
  db: Db,
  transactionIds: readonly string[],
  invoiceId: string,
): Promise<void> {
  if (transactionIds.length === 0) {
    return;
  }

  await db
    .updateTable('transactions')
    .set({ invoiced_by: invoiceId })
    .where('id', 'in', [...transactionIds])
    .where('invoiced_by', 'is', null)
    .execute();
}
