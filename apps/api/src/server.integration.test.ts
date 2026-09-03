import type { Database } from '@billing/db';
import { createDatabase, createPool, migrate, resetSchema } from '@billing/db';
import { VirtualClock } from '@billing/domain';
import { SequentialIdGenerator } from '@billing/platform';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'test_api_server';
const TIME_ZONE = 'Europe/Berlin';
const START = '2026-09-01T09:00:00+02:00[Europe/Berlin]';

/**
 * The HTTP surface against a real database.
 *
 * Nothing is mocked: `inject` skips the socket, not the routing, the schema
 * validation or the transaction. An idempotency test against a fake database
 * would prove nothing, since the guarantee is that the key and its effect
 * commit together (ADR-0004).
 */
describeIfDatabase('API server', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Kysely<Database>;
  let clock: VirtualClock;
  let app: FastifyInstance;
  let keyCounter = 0;

  const key = () => `key-${(keyCounter += 1)}`;

  async function createMerchant(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/merchants',
      headers: { 'idempotency-key': key() },
      payload: {
        // Emails are unique per merchant, so each test gets its own.
        email: `api-${keyCounter}@example.com`,
        name: 'Cafe Kreuzberg',
        marketId: 'DE',
        billingTimeZone: TIME_ZONE,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
    clock = VirtualClock.at(START);

    app = buildServer({ db, clock, ids: new SequentialIdGenerator() });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  describe('POST /v1/merchants', () => {
    it('rejects an unknown plan without a 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/merchants',
        headers: { 'idempotency-key': key() },
        payload: {
          email: `unknown-plan-${keyCounter}@example.com`,
          name: 'Cafe Kreuzberg',
          marketId: 'DE',
          billingTimeZone: TIME_ZONE,
          planId: 'platinum_elite',
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/no-such-plan',
      });
    });
  });

  describe('POST /v1/merchants/:merchantId/transactions', () => {
    it('freezes the local date in the merchant billing zone, not UTC', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/transactions`,
        headers: { 'idempotency-key': key() },
        // 22:30 UTC is already the next day in Berlin. The date a transaction
        // is rated against is the merchant's, never the server's.
        payload: {
          gross: { amount: 413_000, currency: 'EUR' },
          channel: 'in_person',
          occurredAt: '2026-09-09T22:30:00Z',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        gross: { amount: 413_000, currency: 'EUR' },
        channel: 'in_person',
        occurredOn: '2026-09-10',
      });
    });

    it('replays a retried request instead of recording the volume twice', async () => {
      const merchantId = await createMerchant();
      const idempotencyKey = key();
      const payload = {
        gross: { amount: 250_00, currency: 'EUR' },
        channel: 'online',
        occurredAt: '2026-09-11T10:00:00Z',
      };
      const send = () =>
        app.inject({
          method: 'POST',
          url: `/v1/merchants/${merchantId}/transactions`,
          headers: { 'idempotency-key': idempotencyKey },
          payload,
        });

      const first = await send();
      const retry = await send();

      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotency-replayed']).toBe('true');
      expect(retry.json()).toEqual(first.json());

      const rows = await db
        .selectFrom('transactions')
        .select('id')
        .where('merchant_id', '=', merchantId)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it('rejects a key reused for a different request', async () => {
      const merchantId = await createMerchant();
      const idempotencyKey = key();
      const send = (amount: number) =>
        app.inject({
          method: 'POST',
          url: `/v1/merchants/${merchantId}/transactions`,
          headers: { 'idempotency-key': idempotencyKey },
          payload: {
            gross: { amount, currency: 'EUR' },
            channel: 'online',
            occurredAt: '2026-09-11T10:00:00Z',
          },
        });

      await send(100_00);
      const reused = await send(900_00);

      expect(reused.statusCode).toBe(422);
      expect(reused.headers['content-type']).toContain('application/problem+json');
      expect(reused.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/idempotency-key-reused',
        status: 422,
      });
    });

    it('requires an Idempotency-Key', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/transactions`,
        payload: {
          gross: { amount: 100_00, currency: 'EUR' },
          channel: 'online',
          occurredAt: '2026-09-11T10:00:00Z',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/idempotency-key-required',
      });
    });
  });

  describe('POST /v1/merchants/:merchantId/subscription/plan-changes', () => {
    it('closes the old interval and opens the new one at the change date', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes`,
        headers: { 'idempotency-key': key() },
        payload: { planId: 'payments_plus', effectiveFrom: '2026-09-15' },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        backdated: false,
        intervals: [
          { planId: 'standard', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-15' },
          { planId: 'payments_plus', effectiveFrom: '2026-09-15', effectiveTo: null },
        ],
      });
    });

    it('supersedes rather than overwrites when the change reaches into the past', async () => {
      const merchantId = await createMerchant();
      const subscription = await app.inject({
        method: 'GET',
        url: `/v1/merchants/${merchantId}/subscription`,
      });
      const subscriptionId = subscription.json<{ id: string }>().id;

      clock.advance({ days: 19 });
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/merchants/${merchantId}/subscription/plan-changes`,
          headers: { 'idempotency-key': key() },
          // Today is 20 September; this rewrites what we believed on the 15th.
          payload: { planId: 'payments_plus', effectiveFrom: '2026-09-15' },
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ backdated: true });
      } finally {
        clock.setTo(Temporal.ZonedDateTime.from(START));
      }

      // The version that was current when an invoice might have been issued is
      // still there. Losing it would make "what did we think at the time"
      // unanswerable — the first question asked about a disputed charge.
      const superseded = await db
        .selectFrom('rate_intervals')
        .select(['id', 'plan_id', 'effective_to'])
        .where('subscription_id', '=', subscriptionId)
        .where('superseded_at', 'is not', null)
        .execute();

      expect(superseded).toMatchObject([{ plan_id: 'standard', effective_to: null }]);
    });

    it('rejects an unknown plan without a 500', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes`,
        headers: { 'idempotency-key': key() },
        payload: { planId: 'platinum_elite' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/no-such-plan',
        status: 422,
      });
    });

    it('rejects a change to the plan the subscription is already on', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes`,
        headers: { 'idempotency-key': key() },
        payload: { planId: 'standard' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/plan-change-rejected',
        status: 422,
      });
    });
  });
});
