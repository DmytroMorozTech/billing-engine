/**
 * The composition root.
 *
 * The only file that reads the environment, opens a pool, or decides what a
 * clock is. Everything below it takes its dependencies as arguments, which is
 * why the whole API can be exercised in tests against a virtual clock and a
 * throwaway schema.
 *
 * Migrations deliberately do not run here. Two instances starting at once
 * would race, and a rolled-back deploy must not quietly take the schema with
 * it: `npm run migrate -w @billing/db` is its own step, and its own compose
 * service.
 */
import { createDatabase, createPool } from '@billing/db';
import { SystemClock, Uuid7Generator } from '@billing/platform';

import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);

const app = await buildServer({
  db,
  // UTC, never the host's zone. Every merchant-facing calculation takes the
  // merchant's zone explicitly — ADR-0002.
  clock: new SystemClock(),
  ids: new Uuid7Generator(),
  logger: true,
});

/**
 * Stop serving before closing the pool, and close the pool before exiting.
 *
 * A container that is killed mid-request leaves a transaction to be rolled
 * back by a timeout, and the requests in flight here are the ones that move
 * money. `app.close()` drains them first.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  // 0.0.0.0, not localhost: inside a container, localhost is reachable only
  // from the container itself, and the port publish then goes nowhere.
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await pool.end();
  process.exit(1);
}
