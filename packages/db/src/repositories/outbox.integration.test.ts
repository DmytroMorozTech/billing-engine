import type { Kysely } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import { claimUnpublished, enqueue, markPublished, unpublishedCount } from './outbox.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_outbox';

/**
 * The outbox, tested where its guarantee actually lives.
 *
 * The whole point is the transaction boundary, and a transaction boundary
 * cannot be tested against a double: it is the database that keeps the event
 * and the change it describes together, or discards both.
 */
describeIfDatabase('outbox', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('outbox').execute();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('keeps an event written alongside the change it describes', async () => {
    await db.transaction().execute((tx) =>
      enqueue(tx, {
        aggregate: 'invoice:1',
        eventType: 'invoice.finalised',
        payload: { number: 'DE-2026-000001' },
      }),
    );

    const [event] = await db.transaction().execute((tx) => claimUnpublished(tx, 10));

    expect(event).toMatchObject({
      aggregate: 'invoice:1',
      eventType: 'invoice.finalised',
      payload: { number: 'DE-2026-000001' },
    });
  });

  it('discards the event when the transaction that wrote it rolls back', async () => {
    // The failure mode this table exists to prevent, from the other side: an
    // event describing something that never happened is worse than a lost one,
    // because a consumer will act on it.
    await expect(
      db.transaction().execute(async (tx) => {
        await enqueue(tx, {
          aggregate: 'invoice:2',
          eventType: 'invoice.finalised',
          payload: {},
        });
        throw new Error('the billing run failed');
      }),
    ).rejects.toThrow('the billing run failed');

    expect(await unpublishedCount(db)).toBe(0);
  });

  it('hands the oldest events out first, and only the unpublished ones', async () => {
    for (const n of [1, 2, 3]) {
      await db.transaction().execute((tx) =>
        enqueue(tx, { aggregate: `invoice:${n}`, eventType: 'invoice.finalised', payload: { n } }),
      );
    }

    const first = await db.transaction().execute(async (tx) => {
      const claimed = await claimUnpublished(tx, 2);
      await markPublished(
        tx,
        claimed.map((event) => event.id),
      );
      return claimed;
    });

    expect(first.map((event) => event.aggregate)).toEqual(['invoice:1', 'invoice:2']);
    expect(await unpublishedCount(db)).toBe(1);

    const second = await db.transaction().execute((tx) => claimUnpublished(tx, 10));
    expect(second.map((event) => event.aggregate)).toEqual(['invoice:3']);
  });

  it('does not hand the same event to two relays at once', async () => {
    // Two workers is the normal deployment, not an exotic case. Without
    // SKIP LOCKED the second one blocks until the first commits and then
    // publishes the very same events again.
    for (const n of [1, 2]) {
      await db.transaction().execute((tx) =>
        enqueue(tx, { aggregate: `invoice:${n}`, eventType: 'invoice.finalised', payload: {} }),
      );
    }

    let releaseFirst: () => void = () => undefined;
    const firstHasClaimed = new Promise<string[]>((resolve) => {
      void db.transaction().execute(async (tx) => {
        const claimed = await claimUnpublished(tx, 1);
        resolve(claimed.map((event) => event.aggregate));
        // Hold the transaction open while the second relay tries.
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      });
    });

    const claimedByFirst = await firstHasClaimed;
    const claimedBySecond = await db
      .transaction()
      .execute((tx) => claimUnpublished(tx, 1))
      .then((events) => events.map((event) => event.aggregate));
    releaseFirst();

    expect(claimedByFirst).toEqual(['invoice:1']);
    expect(claimedBySecond).toEqual(['invoice:2']);
  });
});
