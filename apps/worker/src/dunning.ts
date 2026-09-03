import { enqueue, markUncollectible, setSubscriptionStatus } from '@billing/db';
import { afterFailedAttempt } from '@billing/domain';

import { chargeInvoice, type ChargeDependencies } from './charge.js';

export interface DunningInput {
  invoiceId: string;
  attempt: number;
}

export interface DunningStep {
  status: 'succeeded' | 'failed';
  declineCode?: string;
  /** What the queue should schedule next, or null when the sequence is over. */
  next: { attempt: number; waitDays: number } | null;
  /** True when this failure was the last one allowed. */
  exhausted?: boolean;
}

/**
 * One step of the dunning sequence: collect, then decide what follows.
 *
 * Deciding and scheduling are separated on purpose. This returns the delay
 * rather than sleeping through it or reaching for a queue, so the whole
 * sequence can be played out in a test in milliseconds — the same trick the
 * virtual clock plays on the billing side, and for the same reason: a sequence
 * that takes a week to observe is a sequence nobody observes.
 *
 * Every step is safe to deliver twice. The charge itself is idempotent by key,
 * the attempt row is unique per (invoice, attempt), and the status changes are
 * guarded on the state they are moving from.
 */
export async function processDunning(
  deps: ChargeDependencies,
  input: DunningInput,
): Promise<DunningStep> {
  const result = await chargeInvoice(deps, input);

  const subscription = await deps.db
    .selectFrom('invoices')
    .innerJoin('subscriptions', 'subscriptions.id', 'invoices.subscription_id')
    .select(['subscriptions.id as id', 'subscriptions.status as status'])
    .where('invoices.id', '=', input.invoiceId)
    .executeTakeFirstOrThrow();

  if (result.status === 'succeeded') {
    if (result.charged) {
      await deps.db.transaction().execute(async (tx) => {
        // Being late is not being suspended: a merchant who pays on the third
        // attempt is a paying merchant again.
        await setSubscriptionStatus(tx, subscription.id, 'active', ['past_due']);
        await enqueue(tx, {
          aggregate: `invoice:${input.invoiceId}`,
          eventType: 'payment.succeeded',
          payload: { invoiceId: input.invoiceId, attempt: input.attempt },
        });
      });
    }

    return { status: 'succeeded', next: null };
  }

  // Nothing was asked of the provider, because the invoice had already left
  // `open` — the sequence ended before this step was delivered. Announcing
  // another failure here would be reporting an event that did not happen.
  if (!result.charged) {
    return { status: 'failed', next: null };
  }

  const decision = afterFailedAttempt(input.attempt);

  await deps.db.transaction().execute(async (tx) => {
    await enqueue(tx, {
      aggregate: `invoice:${input.invoiceId}`,
      eventType: 'payment.failed',
      payload: {
        invoiceId: input.invoiceId,
        attempt: input.attempt,
        declineCode: result.declineCode ?? null,
        willRetry: decision.kind === 'retry',
      },
    });

    if (decision.kind === 'retry') {
      await setSubscriptionStatus(tx, subscription.id, 'past_due', ['active']);
      return;
    }

    // Out of attempts. The invoice stops being something we expect to collect
    // and the subscription stops being something the merchant can use — but
    // the debt stays on the ledger either way.
    await markUncollectible(tx, input.invoiceId);
    await setSubscriptionStatus(tx, subscription.id, 'suspended', ['active', 'past_due']);
    await enqueue(tx, {
      aggregate: `invoice:${input.invoiceId}`,
      eventType: 'dunning.exhausted',
      payload: { invoiceId: input.invoiceId, attempts: input.attempt },
    });
  });

  return {
    status: 'failed',
    ...(result.declineCode === undefined ? {} : { declineCode: result.declineCode }),
    next:
      decision.kind === 'retry'
        ? { attempt: decision.attempt, waitDays: decision.wait.days }
        : null,
    ...(decision.kind === 'exhausted' ? { exhausted: true } : {}),
  };
}
