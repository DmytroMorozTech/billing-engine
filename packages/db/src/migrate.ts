import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  name: string;
  applied: boolean;
  /** True when the file has changed since it was applied. */
  drifted: boolean;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies pending migrations, each inside its own transaction.
 *
 * Per migration rather than one transaction for all of them: a failure then
 * leaves the database at a known, named point rather than somewhere in the
 * middle of a batch. Postgres runs DDL transactionally, so a migration that
 * fails halfway rolls back completely.
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const migration of migrations) {
      const previous = seen.get(migration.name);

      if (previous !== undefined) {
        // An applied migration that has since been edited means the database
        // and the repository disagree about what the schema is. Refuse rather
        // than guess: the fix is a new migration, never an edit to an old one.
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} has changed since it was applied. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  } finally {
    client.release();
  }

  return applied;
}

export async function status(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    return migrations.map((m) => {
      const previous = seen.get(m.name);
      return {
        name: m.name,
        applied: previous !== undefined,
        drifted: previous !== undefined && previous !== m.checksum,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Drops and recreates a schema. Tests only.
 *
 * `IF EXISTS` because a test file may be the first to touch its own schema,
 * and because two files racing on the same one should fail loudly on a
 * constraint rather than confusingly on a missing schema.
 */
export async function resetSchema(pool: pg.Pool, schema = 'public'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    client.release();
  }
}
