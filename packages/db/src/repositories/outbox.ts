import type { Transaction } from 'kysely';

import type { Database } from '../schema.js';
import type { Db } from './subscriptions.js';

export interface NewOutboxEvent {
  /** What the event is about, e.g. `invoice:<id>`. */
  aggregate: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxEvent extends NewOutboxEvent {
  id: number;
  createdAt: Date;
}

/**
 * Writes an event inside the transaction that made it true.
 *
 * Takes a `Transaction` and not a `Kysely`, for the same reason
 * `finaliseInvoice` does: an event written on its own connection has already
 * lost the guarantee it exists for. If the surrounding work rolls back, this
 * row must go with it — a consumer acting on an event describing something that
 * never happened is worse than a consumer that never heard. See ADR-0005.
 */
export async function enqueue(
  tx: Transaction<Database>,
  event: NewOutboxEvent,
): Promise<void> {
  await tx
    .insertInto('outbox')
    .values({
      aggregate: event.aggregate,
      event_type: event.eventType,
      payload: JSON.stringify(event.payload ?? null),
    })
    .execute();
}

/**
 * Takes a batch of unpublished events for this relay to deal with.
 *
 * `SKIP LOCKED` rather than plain `FOR UPDATE`: two workers is the normal
 * deployment. Without it the second one waits for the first to commit and then
 * reads rows that were just published, so every event goes out twice. With it
 * the two simply take different rows.
 *
 * Must run inside the transaction that publishes and marks them, so that a
 * crash mid-flight releases the rows for the next attempt rather than stranding
 * them.
 */
export async function claimUnpublished(
  tx: Transaction<Database>,
  limit: number,
): Promise<OutboxEvent[]> {
  const rows = await tx
    .selectFrom('outbox')
    .select(['id', 'aggregate', 'event_type', 'payload', 'created_at'])
    .where('published_at', 'is', null)
    // Oldest first: events about one aggregate arrive in the order they
    // happened, which a consumer reconstructing state depends on.
    .orderBy('id')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();

  return rows.map((row) => ({
    id: row.id,
    aggregate: row.aggregate,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

/** Marks a published batch, in the same transaction that claimed it. */
export async function markPublished(
  tx: Transaction<Database>,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await tx
    .updateTable('outbox')
    .set({ published_at: new Date() })
    .where('id', 'in', [...ids])
    .execute();
}

/** How far behind the relay is. The number an on-call engineer looks at first. */
export async function unpublishedCount(db: Db): Promise<number> {
  const row = await db
    .selectFrom('outbox')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('published_at', 'is', null)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}
