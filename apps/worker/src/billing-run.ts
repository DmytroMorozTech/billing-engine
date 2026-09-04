import type { Database } from '@billing/db';
import {
  currentRateIntervals,
  finaliseInvoice,
  invoicePostings,
  markInvoiced,
  merchantContext,
  periodAlreadyInvoiced,
  persistInvoiceDraft,
  postTransfer,
  uninvoicedInPeriod,
  vatTreatmentFor,
} from '@billing/db';
import type { BillingPeriod, Money } from '@billing/domain';
import { buildInvoice, zero } from '@billing/domain';
import type { IdGenerator } from '@billing/platform';
import type { Kysely } from 'kysely';
import type { Temporal } from 'temporal-polyfill';

export interface BillingRunDependencies {
  db: Kysely<Database>;
  ids: IdGenerator;
}

export interface BillingRunInput {
  subscriptionId: string;
  /** The period being closed. Half-open, in the merchant's billing zone. */
  period: BillingPeriod;
  /** The issue date, in the legal entity's calendar. Decides the number's year. */
  issuedOn: Temporal.PlainDate;
  dueOn: Temporal.PlainDate;
}

export interface BillingRunResult {
  /** Null when the period had nothing to bill. */
  invoiceId: string | null;
  number: string | null;
  total: Money;
  /** True when an invoice for this period already existed. */
  alreadyBilled: boolean;
}

/**
 * Bills one closed period for one subscription.
 *
 * The whole thing in one transaction, because half of it applied is a merchant
 * charged by a ledger entry for an invoice that does not exist, or an invoice
 * nobody owes. The steps are ordered so the invoice exists before anything
 * points at it: draft, claim the transactions, number it, then move the money.
 *
 * Running it twice is a no-op rather than a second charge. The check is
 * explicit, and the unique index on (subscription_id, period_start) is the
 * backstop for the race the check cannot win on its own.
 *
 * VAT is decided from the merchant, not passed in. A caller that could choose
 * the rate is a caller that can get it wrong, and this is the one place that
 * knows which market and which VAT ID apply.
 */
export async function runBillingCycle(
  deps: BillingRunDependencies,
  input: BillingRunInput,
): Promise<BillingRunResult> {
  const subscription = await deps.db
    .selectFrom('subscriptions')
    .select(['id', 'merchant_id'])
    .where('id', '=', input.subscriptionId)
    .executeTakeFirstOrThrow();

  const merchant = await merchantContext(deps.db, subscription.merchant_id);
  const nothing = zero(merchant.currency);

  const existing = await deps.db
    .selectFrom('invoices')
    .select(['id', 'number', 'total_minor'])
    .where('subscription_id', '=', input.subscriptionId)
    .where('period_start', '=', input.period.start.toString())
    .where('status', '!=', 'void')
    .executeTakeFirst();

  if (existing) {
    return {
      invoiceId: existing.id,
      number: existing.number,
      total: { amount: existing.total_minor, currency: merchant.currency },
      alreadyBilled: true,
    };
  }

  const intervals = await currentRateIntervals(deps.db, input.subscriptionId);
  const transactions = await uninvoicedInPeriod(deps.db, merchant.id, input.period);

  const draft = buildInvoice({
    period: input.period,
    currency: merchant.currency,
    intervals,
    transactions,
    vat: vatTreatmentFor(merchant),
  });

  // A free plan with no volume owes nothing. An invoice for zero is paperwork
  // nobody asked for, and it would consume a number from a series that has to
  // stay meaningful.
  if (draft.total.amount === 0 && draft.lines.length === 0) {
    return { invoiceId: null, number: null, total: nothing, alreadyBilled: false };
  }

  const invoiceId = deps.ids.next();
  const transferId = deps.ids.next();
  const lineIds = draft.lines.map(() => deps.ids.next());

  const number = await deps.db.transaction().execute(async (tx) => {
    await persistInvoiceDraft(tx, {
      id: invoiceId,
      merchantId: merchant.id,
      subscriptionId: input.subscriptionId,
      legalEntityId: merchant.legalEntityId,
      draft,
      lineIds,
    });

    await markInvoiced(
      tx,
      transactions.map((transaction) => transaction.id),
      invoiceId,
    );

    const issued = await finaliseInvoice(tx, invoiceId, {
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
    });

    const postings = invoicePostings({
      merchantId: merchant.id,
      subtotal: draft.subtotal,
      vat: draft.vat,
      total: draft.total,
    });

    if (postings.length > 0) {
      await postTransfer(tx, {
        id: transferId,
        kind: 'invoice_charge',
        occurredAt: new Date(),
        reference: { type: 'invoice', id: invoiceId },
        postings,
      });
    }

    return issued;
  });

  return { invoiceId, number, total: draft.total, alreadyBilled: false };
}

/** True when this subscription's period has already produced an invoice. */
export async function alreadyBilled(
  deps: Pick<BillingRunDependencies, 'db'>,
  subscriptionId: string,
  period: BillingPeriod,
): Promise<boolean> {
  return periodAlreadyInvoiced(deps.db, subscriptionId, period.start.toString());
}
