import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from './connection.js';
import { migrate, resetSchema } from './migrate.js';

/**
 * These tests exist because the invariants they check live in the database,
 * not in the application. Asserting them in TypeScript would only prove that
 * the TypeScript is consistent with itself.
 *
 * Skipped when DATABASE_URL is absent so that `npm test` stays fast and
 * offline. CI sets it and runs them for real.
 */
const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

/** Own schema: Vitest runs test files in parallel and this one drops its tables. */
const SCHEMA = 'test_constraints';

const MERCHANT = '00000000-0000-7000-8000-000000000001';
const SUBSCRIPTION = '00000000-0000-7000-8000-000000000002';

describeIfDatabase('database constraints', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);

    await pool.query(
      `INSERT INTO merchants (id, legal_entity_id, market_id, currency, email, name, billing_time_zone)
       VALUES ($1, 'de-gmbh', 'DE', 'EUR', 'merchant@example.com', 'Cafe Kreuzberg', 'Europe/Berlin')`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO subscriptions (id, merchant_id, anchor_date, status, started_on)
       VALUES ($1, $2, '2026-01-31', 'active', '2026-01-31')`,
      [SUBSCRIPTION, MERCHANT],
    );
    await pool.query(
      `INSERT INTO ledger_accounts (key, kind, merchant_id, currency)
       VALUES ('merchant:1:wallet', 'liability', $1, 'EUR')`,
      [MERCHANT],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function insertRateInterval(
    id: string,
    planId: string,
    from: string,
    to: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO rate_intervals
         (id, subscription_id, plan_id, monthly_fee_minor, currency,
          in_person_rate_bps, online_rate_bps, moto_rate_bps, effective_from, effective_to)
       SELECT $1, $2, p.id, p.monthly_fee_minor, p.currency,
              p.in_person_rate_bps, p.online_rate_bps, p.moto_rate_bps, $4, $5
         FROM plans p WHERE p.id = $3`,
      [id, SUBSCRIPTION, planId, from, to],
    );
  }

  describe('rate intervals cannot overlap', () => {
    const first = '00000000-0000-7000-8000-00000000a001';
    const overlapping = '00000000-0000-7000-8000-00000000a002';
    const adjacent = '00000000-0000-7000-8000-00000000a003';

    it('accepts the first interval', async () => {
      await expect(
        insertRateInterval(first, 'standard', '2026-01-31', '2026-09-15'),
      ).resolves.not.toThrow();
    });

    it('rejects an interval that overlaps it', async () => {
      // Two rates in force at once would let a single transaction be priced
      // twice. Postgres refuses before the application ever gets the chance.
      await expect(
        insertRateInterval(overlapping, 'payments_plus', '2026-09-01', null),
      ).rejects.toThrow(/exclusion constraint/i);
    });

    it('accepts an interval that starts exactly where the previous ends', async () => {
      // Half-open ranges: [.., 2026-09-15) and [2026-09-15, ..) do not overlap.
      await expect(
        insertRateInterval(adjacent, 'payments_plus', '2026-09-15', null),
      ).resolves.not.toThrow();
    });

    it('rewrites the timeline for a backdated correction', async () => {
      const shortened = '00000000-0000-7000-8000-00000000a004';
      const corrected = '00000000-0000-7000-8000-00000000a005';

      // The merchant actually upgraded on 5 September; we recorded the 15th.
      // A backdated correction is not one row replacing one row — it
      // supersedes *every* interval it touches and lays down a new timeline.
      // Here that means both the Standard interval, whose end moves back to
      // the 5th, and the Plus interval, whose start does.
      //
      // Only valid as a whole, which is what the transaction and the deferred
      // foreign key are for: the superseding row must be able to name a row
      // that does not exist until later in the same transaction.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE rate_intervals SET superseded_at = now(), superseded_by = $2 WHERE id = $1',
          [first, shortened],
        );
        await client.query(
          'UPDATE rate_intervals SET superseded_at = now(), superseded_by = $2 WHERE id = $1',
          [adjacent, corrected],
        );
        await client.query(
          `INSERT INTO rate_intervals
             (id, subscription_id, plan_id, monthly_fee_minor, currency,
              in_person_rate_bps, online_rate_bps, moto_rate_bps, effective_from, effective_to)
           SELECT $1, $2, p.id, p.monthly_fee_minor, p.currency,
                  p.in_person_rate_bps, p.online_rate_bps, p.moto_rate_bps, $4::date, $5::date
             FROM plans p WHERE p.id = $3`,
          [shortened, SUBSCRIPTION, 'standard', '2026-01-31', '2026-09-05'],
        );
        await client.query(
          `INSERT INTO rate_intervals
             (id, subscription_id, plan_id, monthly_fee_minor, currency,
              in_person_rate_bps, online_rate_bps, moto_rate_bps, effective_from, effective_to)
           SELECT $1, $2, p.id, p.monthly_fee_minor, p.currency,
                  p.in_person_rate_bps, p.online_rate_bps, p.moto_rate_bps, $4::date, NULL
             FROM plans p WHERE p.id = $3`,
          [corrected, SUBSCRIPTION, 'payments_plus', '2026-09-05'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      // Current knowledge: two intervals meeting on the 5th, no overlap.
      const { rows } = await pool.query<{ effective_from: string; effective_to: string | null }>(
        `SELECT effective_from, effective_to FROM rate_intervals
          WHERE subscription_id = $1 AND superseded_at IS NULL
          ORDER BY effective_from`,
        [SUBSCRIPTION],
      );
      expect(rows).toEqual([
        { effective_from: '2026-01-31', effective_to: '2026-09-05' },
        { effective_from: '2026-09-05', effective_to: null },
      ]);

      // History is kept, not overwritten: the version that said the 15th is
      // still there for the support timeline to show.
      const { rows: history } = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM rate_intervals
          WHERE subscription_id = $1 AND superseded_at IS NOT NULL`,
        [SUBSCRIPTION],
      );
      expect(history[0]?.count).toBe(2);
    });
  });

  describe('ledger', () => {
    const balanced = '00000000-0000-7000-8000-00000000b001';
    const unbalanced = '00000000-0000-7000-8000-00000000b002';

    it('accepts a transfer whose entries sum to zero', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "INSERT INTO ledger_transfers (id, kind, occurred_at) VALUES ($1, 'invoice_charge', now())",
          [balanced],
        );
        // The worked example from ADR-0006: €140.71 total, of which €22.47 VAT.
        for (const [account, amount] of [
          ['merchant:1:wallet', -14_071],
          ['platform:revenue', 11_824],
          ['platform:vat_payable', 2247],
        ] as const) {
          await client.query(
            'INSERT INTO ledger_entries (transfer_id, account_key, amount_minor, currency) VALUES ($1, $2, $3, $4)',
            [balanced, account, amount, 'EUR'],
          );
        }
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await pool.query<{ balance: number }>(
        'SELECT SUM(amount_minor)::bigint AS balance FROM ledger_entries WHERE account_key = $1',
        ['merchant:1:wallet'],
      );
      expect(rows[0]?.balance).toBe(-14_071);
    });

    it('rejects an unbalanced transfer at COMMIT, not before', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "INSERT INTO ledger_transfers (id, kind, occurred_at) VALUES ($1, 'broken', now())",
          [unbalanced],
        );

        // Both inserts succeed. The constraint is deferred, because the
        // entries of one transfer arrive as separate statements and the check
        // is only meaningful once the transfer is complete.
        await expect(
          client.query(
            "INSERT INTO ledger_entries (transfer_id, account_key, amount_minor, currency) VALUES ($1, 'merchant:1:wallet', -100, 'EUR')",
            [unbalanced],
          ),
        ).resolves.toBeDefined();
        await expect(
          client.query(
            "INSERT INTO ledger_entries (transfer_id, account_key, amount_minor, currency) VALUES ($1, 'platform:revenue', 99, 'EUR')",
            [unbalanced],
          ),
        ).resolves.toBeDefined();

        await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/i);
      } finally {
        // A failed COMMIT leaves nothing to roll back, but an assertion that
        // throws earlier would — and a client returned to the pool mid
        // transaction poisons every test that borrows it next.
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('is append-only', async () => {
      await expect(
        pool.query("UPDATE ledger_entries SET amount_minor = 1 WHERE account_key = 'platform:revenue'"),
      ).rejects.toThrow(/append-only/i);

      await expect(
        pool.query("DELETE FROM ledger_entries WHERE account_key = 'platform:revenue'"),
      ).rejects.toThrow(/append-only/i);
    });

    it('sums to zero across the whole system', async () => {
      const { rows } = await pool.query<{ total: number }>(
        'SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM ledger_entries',
      );
      expect(rows[0]?.total).toBe(0);
    });
  });

  describe('type parsers', () => {
    it('returns BIGINT money as a number, not a string', async () => {
      const { rows } = await pool.query<{ monthly_fee_minor: unknown }>(
        "SELECT monthly_fee_minor FROM plans WHERE id = 'payments_plus'",
      );
      expect(rows[0]?.monthly_fee_minor).toBe(1900);
    });

    it('returns DATE as an ISO string, not a zone-shifted Date', async () => {
      const { rows } = await pool.query<{ anchor_date: unknown }>(
        'SELECT anchor_date FROM subscriptions WHERE id = $1',
        [SUBSCRIPTION],
      );
      // A JS Date here would render as 2026-01-30 for anyone west of UTC.
      expect(rows[0]?.anchor_date).toBe('2026-01-31');
    });
  });

  describe('invoice numbering', () => {
    it('refuses a draft that already carries a number', async () => {
      await expect(
        pool.query(
          `INSERT INTO invoices (id, merchant_id, subscription_id, legal_entity_id, number, status,
                                 period_start, period_end, currency, subtotal_minor, vat_minor, total_minor)
           VALUES ('00000000-0000-7000-8000-00000000c001', $1, $2, 'de-gmbh', 'DE-2026-1', 'draft',
                   '2026-09-01', '2026-10-01', 'EUR', 11824, 2247, 14071)`,
          [MERCHANT, SUBSCRIPTION],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it('refuses a total that does not equal subtotal plus VAT', async () => {
      await expect(
        pool.query(
          `INSERT INTO invoices (id, merchant_id, subscription_id, legal_entity_id, status,
                                 period_start, period_end, currency, subtotal_minor, vat_minor, total_minor)
           VALUES ('00000000-0000-7000-8000-00000000c002', $1, $2, 'de-gmbh', 'draft',
                   '2026-09-01', '2026-10-01', 'EUR', 11824, 2247, 99999)`,
          [MERCHANT, SUBSCRIPTION],
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });
});
