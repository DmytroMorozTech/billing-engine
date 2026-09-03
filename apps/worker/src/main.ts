/**
 * The worker: the composition root of the outbox relay.
 *
 * It publishes and nothing else, for now. Consumers arrive with dunning, which
 * is what will actually read these jobs; a worker running an empty handler
 * registry today would be code with nothing to do and tests that prove nothing.
 *
 * Migrations do not run here either — same reason as the API. The schema is one
 * deliberate step, not a side effect of a process starting.
 */
import { createDatabase, createPool, unpublishedCount } from '@billing/db';
import { BullMqPublisher } from '@billing/platform';

import { loadConfig } from './config.js';
import { relayOnce } from './relay.js';

const config = loadConfig(process.env);
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);
const publisher = new BullMqPublisher({ connectionUrl: config.redisUrl });

let running = true;
let draining: Promise<number> = Promise.resolve(0);

function log(fields: Record<string, unknown>): void {
  // The same shape Fastify's logger emits, so both services read alike in a
  // single `docker compose logs`. On stderr, which is where the repository's
  // lint rule puts process output and where `docker logs` collects it anyway.
  console.error(JSON.stringify({ level: 30, time: Date.now(), name: 'worker', ...fields }));
}

/**
 * Polls rather than listens.
 *
 * A constant small query, and the upgrade path is LISTEN/NOTIFY if it ever
 * matters (ADR-0005). Between passes it sleeps; when a pass fills its batch it
 * goes straight round again, so a backlog drains at the speed of the transport
 * instead of one batch per interval.
 */
async function loop(): Promise<void> {
  while (running) {
    try {
      draining = relayOnce({ db, publisher, batchSize: config.batchSize });
      const published = await draining;

      if (published > 0) {
        log({ published, msg: 'relayed' });
      }
      if (published === config.batchSize) {
        continue;
      }
    } catch (error) {
      // The events stay unpublished, so the next pass takes them again. Backing
      // off matters here: a transport that is down stays down for longer than
      // one interval, and a tight retry loop turns an outage into a log flood.
      log({ err: String(error), msg: 'relay pass failed, will retry' });
      await sleep(config.pollIntervalMs * 5);
      continue;
    }

    await sleep(config.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Finishes the pass in flight before closing anything.
 *
 * That pass is holding a transaction open across a publish. Killing the pool
 * underneath it would leave events published but unmarked, which the next
 * worker then publishes a second time.
 */
async function shutdown(signal: string): Promise<void> {
  log({ signal, msg: 'shutting down' });
  running = false;

  try {
    await draining;
  } catch {
    // Already logged by the loop; the rows are unpublished and will be retaken.
  }

  await publisher.close();
  await pool.end();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

log({ batchSize: config.batchSize, pollIntervalMs: config.pollIntervalMs, msg: 'relay started' });
log({ pending: await unpublishedCount(db), msg: 'outbox backlog at startup' });

await loop();
