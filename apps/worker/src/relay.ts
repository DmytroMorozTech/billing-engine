import type { Database } from '@billing/db';
import { claimUnpublished, markPublished } from '@billing/db';
import type { OutboxPublisher } from '@billing/platform';
import type { Kysely } from 'kysely';

export interface RelayDependencies {
  db: Kysely<Database>;
  publisher: OutboxPublisher;
  /** How many events one pass takes. Bounded so a backlog drains steadily. */
  batchSize: number;
}

/**
 * One pass of the relay: claim a batch, publish it, mark it, commit.
 *
 * All three inside one transaction, and in that order. If the transport throws,
 * the transaction rolls back and the rows are simply unclaimed again — the next
 * pass finds them. If it succeeds but the commit fails, the events go out twice
 * and consumers deduplicate, which is why delivery is documented as
 * at-least-once (ADR-0005). The one outcome ruled out is the silent one: an
 * event marked published that nobody ever received.
 *
 * The transaction is held across a network call, which is a thing to do
 * sparingly. It is bounded by `batchSize` and by the transport's own timeout,
 * and the alternative — mark first, publish after — trades a duplicate for a
 * loss.
 */
export async function relayOnce(deps: RelayDependencies): Promise<number> {
  return deps.db.transaction().execute(async (tx) => {
    const events = await claimUnpublished(tx, deps.batchSize);
    if (events.length === 0) {
      return 0;
    }

    await deps.publisher.publish(events);
    await markPublished(
      tx,
      events.map((event) => event.id),
    );

    return events.length;
  });
}
