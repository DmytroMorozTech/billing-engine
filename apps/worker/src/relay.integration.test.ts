import type { Database } from '@billing/db';
import { createDatabase, createPool, enqueue, migrate, resetSchema, unpublishedCount } from '@billing/db';
import type { OutboxPublisher, PublishableEvent } from '@billing/platform';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { relayOnce } from './relay.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_worker_relay';

/** Records what it was given, and fails on demand. */
class FakePublisher implements OutboxPublisher {
  readonly published: PublishableEvent[] = [];
  failNext = false;

  async publish(events: readonly PublishableEvent[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('transport is down');
    }
    this.published.push(...events);
  }

  async close(): Promise<void> {}
}

/**
 * The relay: claim, publish, mark, in one transaction.
 *
 * What is worth testing here is not the happy path but the failure: a transport
 * that dies mid-batch must leave the events unpublished, because at-least-once
 * is the promise and none-at-all is not.
 */
describeIfDatabase('outbox relay', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let publisher: FakePublisher;

  async function given(count: number): Promise<void> {
    for (let n = 1; n <= count; n += 1) {
      await db.transaction().execute((tx) =>
        enqueue(tx, {
          aggregate: `invoice:${n}`,
          eventType: 'invoice.finalised',
          payload: { n },
        }),
      );
    }
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('outbox').execute();
    publisher = new FakePublisher();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('publishes a batch and marks exactly what it published', async () => {
    await given(3);

    const published = await relayOnce({ db, publisher, batchSize: 10 });

    expect(published).toBe(3);
    expect(publisher.published.map((event) => event.aggregate)).toEqual([
      'invoice:1',
      'invoice:2',
      'invoice:3',
    ]);
    expect(await unpublishedCount(db)).toBe(0);
  });

  it('takes no more than a batch at a time', async () => {
    await given(5);

    expect(await relayOnce({ db, publisher, batchSize: 2 })).toBe(2);
    expect(await unpublishedCount(db)).toBe(3);
  });

  it('leaves the batch unpublished when the transport fails', async () => {
    // The rows must come back, not vanish: a marked-but-unsent event is a
    // payment that never gets attempted, and nothing will ever notice.
    await given(2);
    publisher.failNext = true;

    await expect(relayOnce({ db, publisher, batchSize: 10 })).rejects.toThrow('transport is down');

    expect(publisher.published).toEqual([]);
    expect(await unpublishedCount(db)).toBe(2);

    // And the next pass gets them.
    expect(await relayOnce({ db, publisher, batchSize: 10 })).toBe(2);
    expect(await unpublishedCount(db)).toBe(0);
  });

  it('does nothing, cheaply, when there is nothing to send', async () => {
    expect(await relayOnce({ db, publisher, batchSize: 10 })).toBe(0);
    expect(publisher.published).toEqual([]);
  });
});
