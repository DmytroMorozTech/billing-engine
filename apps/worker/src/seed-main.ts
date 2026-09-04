/**
 * Fills an empty database with the demo.
 *
 * A one-shot, like the migration runner, and for the same reason: it is a
 * deliberate step someone takes, not something a service does on the way up.
 *
 * It refuses to run twice. The stories use fixed identifiers and fixed email
 * addresses, so a second pass would collide on the first unique index it met
 * and leave the database half-told. Refusing is also what makes it safe to
 * leave in a compose file that gets restarted.
 */
import { createDatabase, createPool } from '@billing/db';
import { HttpPspClient, SequentialIdGenerator } from '@billing/platform';

import { loadSeedConfig } from './config.js';
import { seedDemoData } from './seed.js';

const config = loadSeedConfig(process.env);
const pool = createPool({ connectionString: config.databaseUrl });
const db = createDatabase(pool);

function report(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 30, time: Date.now(), name: 'seed', ...fields }));
}

try {
  const existing = await db.selectFrom('merchants').select('id').limit(1).executeTakeFirst();

  if (existing) {
    report({ msg: 'database already has merchants; leaving it alone' });
  } else {
    const seeded = await seedDemoData({
      db,
      // Sequential, not UUIDv7: the demo is meant to come out the same every
      // time it is set up, and a time-ordered random id is neither.
      ids: new SequentialIdGenerator(),
      psp: new HttpPspClient({ baseUrl: config.pspUrl }),
    });

    for (const entry of seeded) {
      report({
        story: entry.story,
        merchant: entry.merchantId,
        invoice: entry.invoiceNumber,
        totalMinor: entry.totalMinor,
        msg: 'seeded',
      });
    }
    report({ merchants: seeded.length, msg: 'demo data ready' });
  }
} catch (error) {
  report({ err: error instanceof Error ? error.message : String(error), msg: 'seeding failed' });
  process.exitCode = 1;
} finally {
  await pool.end();
}
