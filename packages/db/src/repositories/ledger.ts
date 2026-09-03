import type { CurrencyCode, Money } from '@billing/domain';
import { money, sum, zero } from '@billing/domain';
import { sql, type Transaction } from 'kysely';

import type { Database } from '../schema.js';
import type { Db } from './subscriptions.js';

export interface LedgerPosting {
  accountKey: string;
  amount: Money;
}

export interface TransferInput {
  id: string;
  kind: string;
  occurredAt: Date;
  reference?: { type: string; id: string };
  postings: readonly LedgerPosting[];
}

export class UnbalancedTransferError extends Error {
  constructor(currency: CurrencyCode, total: number) {
    super(`Transfer does not balance in ${currency}: postings sum to ${total}`);
    this.name = 'UnbalancedTransferError';
  }
}

/**
 * Writes one movement of money.
 *
 * The zero-sum check runs here as well as in the database. That is not
 * duplication for its own sake: the deferred trigger fires at COMMIT and
 * reports a transfer id, while this one fires at the call site and can say
 * which postings were passed in. The database remains the thing that makes the
 * invariant true — see ADR-0003 and ADR-0009 — this only makes it easier to
 * find out why.
 */
export async function postTransfer(
  tx: Transaction<Database>,
  input: TransferInput,
): Promise<void> {
  if (input.postings.length === 0) {
    throw new RangeError('A transfer needs at least one posting');
  }

  const byCurrency = new Map<CurrencyCode, Money[]>();
  for (const posting of input.postings) {
    const existing = byCurrency.get(posting.amount.currency) ?? [];
    existing.push(posting.amount);
    byCurrency.set(posting.amount.currency, existing);
  }

  for (const [currency, amounts] of byCurrency) {
    const total = sum(amounts, currency);
    if (total.amount !== 0) {
      throw new UnbalancedTransferError(currency, total.amount);
    }
  }

  await tx
    .insertInto('ledger_transfers')
    .values({
      id: input.id,
      kind: input.kind,
      occurred_at: input.occurredAt,
      reference_type: input.reference?.type ?? null,
      reference_id: input.reference?.id ?? null,
    })
    .execute();

  await tx
    .insertInto('ledger_entries')
    .values(
      input.postings.map((posting) => ({
        transfer_id: input.id,
        account_key: posting.accountKey,
        amount_minor: posting.amount.amount,
        currency: posting.amount.currency,
      })),
    )
    .execute();
}

/** The wallet account key for a merchant. One place, so it cannot drift. */
export function merchantWalletKey(merchantId: string): string {
  return `merchant:${merchantId}:wallet`;
}

/** Creates the accounts a merchant needs, if they do not exist yet. */
export async function ensureMerchantAccounts(
  db: Db,
  merchantId: string,
  currency: CurrencyCode,
): Promise<void> {
  await db
    .insertInto('ledger_accounts')
    .values({
      key: merchantWalletKey(merchantId),
      kind: 'liability',
      merchant_id: merchantId,
      currency,
    })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
}

/**
 * Balance is derived from the entries, never stored — ADR-0003.
 *
 * At this scale the aggregate is free. If it ever stopped being free, the fix
 * is a snapshot with a watermark that can be rebuilt and verified, not a
 * `balance` column that cannot.
 */
export async function balance(
  db: Db,
  accountKey: string,
  currency: CurrencyCode,
): Promise<Money> {
  const row = await db
    .selectFrom('ledger_entries')
    .select(BALANCE)
    .where('account_key', '=', accountKey)
    .where('currency', '=', currency)
    .executeTakeFirst();

  return row === undefined ? zero(currency) : money(row.total, currency);
}

/** Every entry in the system, which must always come to zero. */
export async function systemTotal(db: Db, currency: CurrencyCode): Promise<Money> {
  const row = await db
    .selectFrom('ledger_entries')
    .select(BALANCE)
    .where('currency', '=', currency)
    .executeTakeFirst();

  return row === undefined ? zero(currency) : money(row.total, currency);
}

/**
 * `SUM` over a `BIGINT` column returns `NUMERIC` in PostgreSQL, because a sum
 * of bigints can overflow one. The driver's NUMERIC parser deliberately throws
 * (ADR-0001 says no column should be NUMERIC), and it caught this — so the cast
 * back to `BIGINT` is explicit here rather than the guard being weakened.
 *
 * Safe: every amount is a safe integer, and a realistic ledger is many orders
 * of magnitude away from overflowing 64 bits.
 */
const BALANCE = sql<number>`COALESCE(SUM(amount_minor), 0)::bigint`.as('total');
