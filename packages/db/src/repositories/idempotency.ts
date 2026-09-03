import { createHash } from 'node:crypto';

import type { Transaction } from 'kysely';

import type { Database } from '../schema.js';
import type { Db } from './subscriptions.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyLookup =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; response: StoredResponse }
  | { outcome: 'conflict' };

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/**
 * Claims an idempotency key, or reports what to do instead.
 *
 * Must be called inside the transaction that performs the action, so that the
 * key and its effect commit together or not at all. That is the entire
 * argument of ADR-0004: a key in Redis and a payment in PostgreSQL cannot be
 * made atomic, and the failure between them either charges a merchant twice or
 * never charges them.
 *
 * - `claimed` — first time; go and do the work, then call {@link recordResponse}.
 * - `replay`  — same key, same payload; return the stored response verbatim.
 *               Not a conflict: a client retrying because it never saw the
 *               first response needs the result.
 * - `conflict` — same key, different payload. The client reused a key for a
 *                different request, which is a mistake worth reporting.
 */
export async function claimKey(
  tx: Transaction<Database>,
  key: string,
  endpoint: string,
  body: unknown,
): Promise<IdempotencyLookup> {
  const requestHash = hashRequest(body);

  const inserted = await tx
    .insertInto('idempotency_keys')
    .values({
      key,
      endpoint,
      request_hash: requestHash,
      response_status: 0,
      response_body: JSON.stringify(null),
    })
    .onConflict((oc) => oc.column('key').doNothing())
    .executeTakeFirst();

  if ((inserted.numInsertedOrUpdatedRows ?? 0n) > 0n) {
    return { outcome: 'claimed' };
  }

  const existing = await tx
    .selectFrom('idempotency_keys')
    .select(['endpoint', 'request_hash', 'response_status', 'response_body'])
    .where('key', '=', key)
    // Locks the row so two concurrent retries of the same key serialise rather
    // than both deciding they are replays of a response that does not exist yet.
    .forUpdate()
    .executeTakeFirstOrThrow();

  if (existing.endpoint !== endpoint || existing.request_hash !== requestHash) {
    return { outcome: 'conflict' };
  }

  // status 0 means the original request claimed the key and has not finished.
  // Treating that as a conflict is wrong — it is the same request — but there
  // is no stored response to replay either, so the caller is told to retry.
  if (existing.response_status === 0) {
    return { outcome: 'conflict' };
  }

  return {
    outcome: 'replay',
    response: { status: existing.response_status, body: existing.response_body },
  };
}

/** Stores the response against a claimed key, in the same transaction. */
export async function recordResponse(
  tx: Transaction<Database>,
  key: string,
  response: StoredResponse,
): Promise<void> {
  await tx
    .updateTable('idempotency_keys')
    .set({
      response_status: response.status,
      response_body: JSON.stringify(response.body ?? null),
    })
    .where('key', '=', key)
    .execute();
}

/** Deletes keys older than the retention window. Client retries live in minutes. */
export async function pruneKeys(db: Db, olderThan: Date): Promise<number> {
  const result = await db
    .deleteFrom('idempotency_keys')
    .where('created_at', '<', olderThan)
    .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0n);
}
