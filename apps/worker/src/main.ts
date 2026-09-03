/**
 * The worker: the composition root of the outbox relay.
 *
 * Two jobs in one process: it relays the outbox into the queue, and it consumes
 * that queue to collect invoices. They are separated by an interface rather
 * than by a container, because nothing yet needs them to scale apart.
 *
 * Migrations do not run here either — same reason as the API. The schema is one
 * deliberate step, not a side effect of a process starting.
 */
import { createDatabase, createPool, unpublishedCount } from '@billing/db';
import {
  BullMqPublisher,
  BullMqRetryScheduler,
  HttpPspClient,
  Uuid7Generator,
} from '@billing/platform';
import { Worker } from 'bullmq';

import { loadConfig } from './config.js';
import { processDunning } from './dunning.js';
import { handleJob } from './handle-job.js';
import { relayOnce } from './relay.js';

const config = loadConfig(process.env);
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);
const publisher = new BullMqPublisher({ connectionUrl: config.redisUrl });
const scheduler = new BullMqRetryScheduler({ connectionUrl: config.redisUrl });
const psp = new HttpPspClient({ baseUrl: config.pspUrl });
const ids = new Uuid7Generator();

/**
 * Consumes what the relay publishes.
 *
 * A job that throws is retried by BullMQ and, after its attempts, lands in the
 * failed set rather than disappearing — which is what the support console's
 * stuck-jobs screen is for. That is deliberately not the same thing as a
 * payment attempt: a job retry is about our own failures.
 */
const consumer = new Worker(
  'outbox',
  async (job) => {
    await handleJob(
      { runDunning: (input) => processDunning({ db, psp, ids }, input), scheduler },
      { name: job.name, data: job.data },
    );
  },
  { connection: { url: config.redisUrl }, concurrency: 4 },
);

consumer.on('failed', (job, error) => {
  log({ job: job?.name, id: job?.id, err: String(error), msg: 'job failed' });
});

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

log({
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
  psp: config.pspUrl,
  msg: 'relay and consumer started',
});
log({ pending: await unpublishedCount(db), msg: 'outbox backlog at startup' });

await loop();
