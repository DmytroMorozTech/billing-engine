import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

const { Pool, types } = pg;

/**
 * node-postgres type parsers, applied once per process.
 *
 * Two of these matter enough to be worth the global mutation:
 *
 * - `int8` (BIGINT) arrives as a string, because a 64-bit integer does not
 *   always survive a double. Ours always do — every amount is validated as a
 *   safe integer before it is written — so parsing back to a number keeps the
 *   Money type honest instead of scattering `Number(row.amount)` everywhere.
 *   The guard below turns a silent precision loss into a loud failure.
 *
 * - `date` arrives as a JS Date in the server's local zone, which is exactly
 *   the bug this project exists to avoid: 2026-09-01 becomes 2026-08-31T22:00Z
 *   for anyone west of UTC. Keeping it as the ISO string it already is means
 *   `Temporal.PlainDate.from(row.occurred_on)` just works.
 */
export function installTypeParsers(): void {
  types.setTypeParser(types.builtins.INT8, (value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(
        `BIGINT ${value} does not fit a safe integer. Money amounts are never this large; something upstream is wrong.`,
      );
    }
    return parsed;
  });

  types.setTypeParser(types.builtins.DATE, (value) => value);
  types.setTypeParser(types.builtins.NUMERIC, (value) => {
    throw new TypeError(
      `NUMERIC column returned ${value}. Money is BIGINT in minor units (ADR-0001); no column should be NUMERIC.`,
    );
  });
}

export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
}

export function createPool(config: DatabaseConfig): pg.Pool {
  installTypeParsers();
  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    // Fail fast rather than queue forever behind an exhausted pool: a billing
    // run that hangs is harder to diagnose than one that errors.
    connectionTimeoutMillis: 5_000,
  });
}

export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export function connectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}
