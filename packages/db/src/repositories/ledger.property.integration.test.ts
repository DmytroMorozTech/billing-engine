import { money, sum } from '@billing/domain';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool } from '../connection.js';
import { migrate, resetSchema } from '../migrate.js';
import type { Database } from '../schema.js';
import {
  balance,
  ensureMerchantAccounts,
  invoicePostings,
  merchantWalletKey,
  postTransfer,
  systemTotal,
  UnbalancedTransferError,
  ZeroPostingError,
} from './ledger.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

/** Own schema, for the same reason as the other integration files. */
const SCHEMA = 'test_ledger_property';

const MERCHANTS = [
  '00000000-0000-7000-8000-0000000000f1',
  '00000000-0000-7000-8000-0000000000f2',
  '00000000-0000-7000-8000-0000000000f3',
];

const eur = (amount: number) => money(amount, 'EUR');

type Operation =
  | { kind: 'charge'; merchant: number; net: number; vat: number }
  | { kind: 'payment'; merchant: number; amount: number }
  | { kind: 'refund'; merchant: number; net: number; vat: number };

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant('charge' as const),
    merchant: fc.integer({ min: 0, max: MERCHANTS.length - 1 }),
    net: fc.integer({ min: 1, max: 5_000_000 }),
    vat: fc.integer({ min: 0, max: 1_000_000 }),
  }),
  fc.record({
    kind: fc.constant('payment' as const),
    merchant: fc.integer({ min: 0, max: MERCHANTS.length - 1 }),
    amount: fc.integer({ min: 1, max: 5_000_000 }),
  }),
  fc.record({
    kind: fc.constant('refund' as const),
    merchant: fc.integer({ min: 0, max: MERCHANTS.length - 1 }),
    net: fc.integer({ min: 1, max: 1_000_000 }),
    vat: fc.integer({ min: 0, max: 200_000 }),
  }),
);

/**
 * The strongest single assertion in the project: money never appears and never
 * disappears, whatever sequence of operations produced it.
 *
 * Run against PostgreSQL rather than an in-memory double, because the invariant
 * is enforced by a deferred constraint trigger there. A pure model would only
 * prove the model is consistent with itself.
 */
describeIfDatabase('ledger invariants under random sequences', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let counter = 0;
  const nextId = () =>
    `00000000-0000-7000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);

    for (const [index, id] of MERCHANTS.entries()) {
      await db
        .insertInto('merchants')
        .values({
          id,
          legal_entity_id: 'de-gmbh',
          market_id: 'DE',
          currency: 'EUR',
          email: `merchant${index}@example.com`,
          name: `Merchant ${index}`,
          billing_time_zone: 'Europe/Berlin',
          vat_id: null,
        })
        .execute();
      await ensureMerchantAccounts(db, id, 'EUR');
    }
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function apply(op: Operation): Promise<void> {
    const wallet = merchantWalletKey(MERCHANTS[op.merchant] as string);

    // Charges and refunds are built the way the billing run builds them, sign
    // included — so a generated `vat: 0` exercises reverse charge rather than
    // a shape production code would never produce.
    const sign = op.kind === 'refund' ? -1 : 1;

    const postings =
      op.kind === 'payment'
        ? [
            { accountKey: wallet, amount: eur(op.amount) },
            { accountKey: 'platform:bank', amount: eur(-op.amount) },
          ]
        : invoicePostings({
            merchantId: MERCHANTS[op.merchant] as string,
            subtotal: eur(sign * op.net),
            vat: eur(sign * op.vat),
            total: eur(sign * (op.net + op.vat)),
          });

    await db.transaction().execute((tx) =>
      postTransfer(tx, {
        id: nextId(),
        kind: op.kind,
        occurredAt: new Date('2026-09-01T00:00:00Z'),
        postings,
      }),
    );
  }

  it('always sums to zero, whatever sequence of operations ran', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 12 }), async (ops) => {
        for (const op of ops) {
          await apply(op);
        }
        expect((await systemTotal(db, 'EUR')).amount).toBe(0);
      }),
      // Each run writes real rows, so the sample is small on purpose. The
      // point is coverage of shapes, not volume.
      { numRuns: 15 },
    );
  }, 120_000);

  it('every balance equals the sum of its own entries', async () => {
    // Balance is derived, never stored (ADR-0003). This asserts the derivation
    // matches the raw rows, which is the thing a stored column could not offer.
    const accounts = [
      ...MERCHANTS.map(merchantWalletKey),
      'platform:revenue',
      'platform:vat_payable',
      'platform:bank',
    ];

    const balances = await Promise.all(
      accounts.map((account) => balance(db, account, 'EUR')),
    );

    for (const [index, account] of accounts.entries()) {
      const rows = await db
        .selectFrom('ledger_entries')
        .select('amount_minor')
        .where('account_key', '=', account)
        .where('currency', '=', 'EUR')
        .execute();

      const fromRows = sum(
        rows.map((row) => eur(row.amount_minor)),
        'EUR',
      );
      expect(balances[index]).toEqual(fromRows);
    }

    expect(sum(balances, 'EUR').amount).toBe(0);
  }, 60_000);

  it('rejects an unbalanced transfer and leaves the total untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Above the discrepancy, so the second posting is never itself zero:
        // that is a different rejection (ZeroPostingError) and this test is
        // about the transfer not balancing.
        fc.integer({ min: 1_000, max: 100_000 }),
        fc.integer({ min: 1, max: 999 }),
        async (amount, discrepancy) => {
          await expect(
            db.transaction().execute((tx) =>
              postTransfer(tx, {
                id: nextId(),
                kind: 'broken',
                occurredAt: new Date('2026-09-01T00:00:00Z'),
                postings: [
                  { accountKey: merchantWalletKey(MERCHANTS[0] as string), amount: eur(-amount) },
                  { accountKey: 'platform:revenue', amount: eur(amount - discrepancy) },
                ],
              }),
            ),
          ).rejects.toThrow(UnbalancedTransferError);

          expect((await systemTotal(db, 'EUR')).amount).toBe(0);
        },
      ),
      { numRuns: 10 },
    );
  }, 60_000);

  it('rejects a posting of zero and names the account it came from', async () => {
    // A zero posting is either meaningless or a bug — an amount that was
    // supposed to be computed and was not. The database forbids it; this says
    // so at the call site, where the account key is still known.
    const promise = db.transaction().execute((tx) =>
      postTransfer(tx, {
        id: nextId(),
        kind: 'charge',
        occurredAt: new Date('2026-09-01T00:00:00Z'),
        postings: [
          { accountKey: merchantWalletKey(MERCHANTS[0] as string), amount: eur(-1000) },
          { accountKey: 'platform:revenue', amount: eur(1000) },
          { accountKey: 'platform:vat_payable', amount: eur(0) },
        ],
      }),
    );

    await expect(promise).rejects.toThrow(ZeroPostingError);
    await expect(promise).rejects.toThrow('platform:vat_payable');
    expect((await systemTotal(db, 'EUR')).amount).toBe(0);
  }, 60_000);
});
