import type { Database } from '@billing/db';
import {
  createDatabase,
  createPool,
  currentRateIntervals,
  finaliseInvoice,
  issueCreditNote,
  liveSubscription,
  merchantContext,
  migrate,
  persistInvoiceDraft,
  recordAttempt,
  resetSchema,
  vatTreatmentFor,
} from '@billing/db';
import { buildInvoice, money, VirtualClock } from '@billing/domain';
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

  // A different prefix from the server's generator, so fixture rows and rows
  // the API writes can never collide on a primary key.
  const fixtureIds = new SequentialIdGenerator('00000000-0000-7000-9000');

  async function createMerchant(planId = 'standard'): Promise<string> {
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
        planId,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /**
   * Issues one real invoice for a period.
   *
   * The draft comes from `buildInvoice` and the number from `finaliseInvoice`,
   * so the row under test is the one the billing run would have written. The
   * run itself lives in `apps/worker`, which the API must not depend on.
   */
  async function issueInvoice(
    merchantId: string,
    start: string,
    end: string,
  ): Promise<{ id: string; number: string }> {
    const merchant = await merchantContext(db, merchantId);
    const subscription = await liveSubscription(db, merchantId);
    if (!subscription) {
      throw new Error(`${merchantId} has no live subscription`);
    }

    const draft = buildInvoice({
      period: { start: Temporal.PlainDate.from(start), end: Temporal.PlainDate.from(end) },
      currency: merchant.currency,
      intervals: await currentRateIntervals(db, subscription.id),
      transactions: [],
      vat: vatTreatmentFor(merchant),
    });

    const id = fixtureIds.next();
    const number = await db.transaction().execute(async (tx) => {
      await persistInvoiceDraft(tx, {
        id,
        merchantId,
        subscriptionId: subscription.id,
        legalEntityId: merchant.legalEntityId,
        draft,
        lineIds: draft.lines.map(() => fixtureIds.next()),
      });
      return finaliseInvoice(tx, id, {
        issuedOn: Temporal.PlainDate.from(end),
        dueOn: Temporal.PlainDate.from(end).add({ days: 14 }),
      });
    });

    return { id, number };
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: connectionString as string, schema: SCHEMA });
    await resetSchema(pool, SCHEMA);
    await migrate(pool);
    db = createDatabase(pool);
    clock = VirtualClock.at(START);

    app = await buildServer({ db, clock, ids: new SequentialIdGenerator() });
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

  describe('GET /v1/merchants/:merchantId', () => {
    it('answers with the market, the VAT treatment and the subscription state', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({ method: 'GET', url: `/v1/merchants/${merchantId}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: merchantId,
        marketId: 'DE',
        currency: 'EUR',
        billingTimeZone: TIME_ZONE,
        // The reason, not only the rate. A merchant with no VAT id in the
        // supplier's own market is an ordinary domestic supply.
        vatTreatment: { kind: 'standard', rateBps: 1900 },
        subscription: {
          status: 'active',
          anchorDate: '2026-09-01',
          planId: 'standard',
          currentPeriod: { start: '2026-09-01', end: '2026-10-01' },
        },
      });
    });

    it('answers a problem document rather than a 500 for an unknown merchant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/merchants/00000000-0000-7000-8000-0000000000ff',
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      // Not `no-such-route`: the route exists, the merchant does not, and a
      // client branching on `type` has to be able to tell those apart.
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/not-found',
      });
    });

    it('rejects an id that is not a uuid at the edge, not at the database', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/merchants/nobody' });

      // `merchants.id` is a UUID column, so an unparseable id reaches PostgreSQL
      // as a type error and leaves as a 500 — an operator's problem, reported as
      // ours. The shape of an id is knowable at the edge, so it is checked there.
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/validation-failed',
      });
    });
  });

  describe('GET /v1/merchants/:merchantId/invoices', () => {
    it('lists the merchant invoices, most recent period first', async () => {
      const merchantId = await createMerchant('payments_plus');
      const september = await issueInvoice(merchantId, '2026-09-01', '2026-10-01');
      const october = await issueInvoice(merchantId, '2026-10-01', '2026-11-01');

      const response = await app.inject({
        method: 'GET',
        url: `/v1/merchants/${merchantId}/invoices`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        invoices: [
          {
            id: october.id,
            number: october.number,
            status: 'open',
            periodStart: '2026-10-01',
            periodEnd: '2026-11-01',
            issuedOn: '2026-11-01',
            dueOn: '2026-11-15',
            // Payments Plus at 19.00 a month, plus 19% German VAT.
            total: { amount: 2261, currency: 'EUR' },
          },
          { id: september.id, number: september.number, periodStart: '2026-09-01' },
        ],
      });
    });

    it('shows only this merchant, never another one', async () => {
      const mine = await createMerchant('payments_plus');
      const theirs = await createMerchant('payments_plus');
      await issueInvoice(theirs, '2026-09-01', '2026-10-01');

      const response = await app.inject({ method: 'GET', url: `/v1/merchants/${mine}/invoices` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ invoices: [] });
    });

    it('is 404 for a merchant who does not exist, not an empty list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/merchants/00000000-0000-7000-8000-0000000000ff/invoices',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/not-found',
      });
    });
  });

  describe('GET /v1/invoices/:invoiceId', () => {
    it('carries the recorded derivation through the response serialiser intact', async () => {
      const merchantId = await createMerchant('payments_plus');
      const invoice = await issueInvoice(merchantId, '2026-09-01', '2026-10-01');

      const response = await app.inject({ method: 'GET', url: `/v1/invoices/${invoice.id}` });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{
        lines: { derivation: { formula: string; inputs: unknown[] } }[];
      }>();

      // The nested tree, not just its top level. A response schema serialises
      // by declaration and drops what it was not told about, which would leave
      // "why this amount" answerable only down to the first level.
      expect(body.lines[0]?.derivation).toMatchObject({
        formula: 'monthly fee × days in segment ÷ days in period',
        inputs: [
          { kind: 'value', label: 'Monthly fee', value: { amount: 1900, currency: 'EUR' } },
          { kind: 'value', label: 'Days in segment', value: 30 },
          { kind: 'value', label: 'Days in period', value: 30 },
          { kind: 'value', label: 'Period', value: '2026-09-01 to 2026-10-01' },
        ],
      });
    });

    it('answers why the merchant is in dunning, not only how much they owe', async () => {
      const merchantId = await createMerchant('payments_plus');
      const invoice = await issueInvoice(merchantId, '2026-09-01', '2026-10-01');

      await db.transaction().execute((tx) =>
        recordAttempt(tx, {
          id: fixtureIds.next(),
          invoiceId: invoice.id,
          attempt: 1,
          status: 'failed',
          declineCode: 'insufficient_funds',
          pspChargeId: 'ch_test_1',
          amount: money(2261, 'EUR'),
          attemptedAt: new Date('2026-11-01T09:00:00Z'),
        }),
      );

      const response = await app.inject({ method: 'GET', url: `/v1/invoices/${invoice.id}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'open',
        total: { amount: 2261, currency: 'EUR' },
        paymentAttempts: [
          {
            attempt: 1,
            status: 'failed',
            declineCode: 'insufficient_funds',
            pspChargeId: 'ch_test_1',
          },
        ],
        creditNotes: [],
      });
    });

    it('reports what is still charged once a credit note has been issued', async () => {
      const merchantId = await createMerchant('payments_plus');
      const merchant = await merchantContext(db, merchantId);
      const invoice = await issueInvoice(merchantId, '2026-09-01', '2026-10-01');

      const creditNoteId = fixtureIds.next();
      const number = await db.transaction().execute((tx) =>
        issueCreditNote(tx, {
          id: creditNoteId,
          merchantId,
          invoiceId: invoice.id,
          legalEntityId: merchant.legalEntityId,
          draft: {
            period: {
              start: Temporal.PlainDate.from('2026-09-01'),
              end: Temporal.PlainDate.from('2026-10-01'),
            },
            currency: 'EUR',
            lines: [
              {
                kind: 'adjustment',
                description: 'Correction',
                amount: money(-500, 'EUR'),
                vatRateBps: 1900,
                derivation: { result: money(-500, 'EUR'), formula: 'agreed', inputs: [] },
              },
            ],
            subtotal: money(-500, 'EUR'),
            vat: money(-95, 'EUR'),
            total: money(-595, 'EUR'),
            vatTreatment: 'standard',
          },
          lineIds: [fixtureIds.next()],
          transferId: fixtureIds.next(),
          issuedOn: Temporal.PlainDate.from('2026-11-02'),
        }),
      );

      const response = await app.inject({ method: 'GET', url: `/v1/invoices/${invoice.id}` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        // What was billed, unchanged. An issued invoice is not rewritten.
        total: { amount: 2261, currency: 'EUR' },
        creditNotes: [{ id: creditNoteId, number, total: { amount: -595, currency: 'EUR' } }],
        // What is still owed after the correction — the number that decides
        // whether this merchant is actually behind on anything.
        netTotal: { amount: 1666, currency: 'EUR' },
      });
    });
  });

  describe('POST /v1/merchants/:merchantId/subscription/plan-changes/preview', () => {
    /**
     * The worked example of ADR-0006, asked as a question instead of applied.
     *
     * 413,000 taken in person on 9 September, then an upgrade proposed for the
     * 15th. The monthly fee prorates by days while the commission keeps the old
     * rate for the volume that came before the change — which is exactly the
     * pair of facts a merchant cannot work out from the price list.
     */
    async function merchantWithVolume(): Promise<string> {
      const merchantId = await createMerchant();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/transactions`,
        headers: { 'idempotency-key': key() },
        payload: {
          gross: { amount: 413_000, currency: 'EUR' },
          channel: 'in_person',
          occurredAt: '2026-09-09T10:00:00Z',
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return merchantId;
    }

    it('prices the period both ways, and leaves the timeline untouched', async () => {
      const merchantId = await merchantWithVolume();
      const subscription = await liveSubscription(db, merchantId);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes/preview`,
        // Deliberately no Idempotency-Key: this endpoint changes nothing, and
        // demanding a key to protect a retry that cannot do harm is ceremony.
        payload: { planId: 'payments_plus', effectiveFrom: '2026-09-15' },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        backdated: false,
        period: { start: '2026-09-01', end: '2026-10-01' },
        current: {
          subtotal: { amount: 6980, currency: 'EUR' },
          vat: { amount: 1326, currency: 'EUR' },
          total: { amount: 8306, currency: 'EUR' },
          lines: [{ kind: 'commission', amount: { amount: 6980, currency: 'EUR' } }],
        },
        proposed: {
          subtotal: { amount: 7993, currency: 'EUR' },
          vat: { amount: 1519, currency: 'EUR' },
          total: { amount: 9512, currency: 'EUR' },
          lines: [
            // 19.00 a month, prorated over the 16 days from the 15th.
            { kind: 'subscription', amount: { amount: 1013, currency: 'EUR' } },
            // Volume taken on the 9th keeps the Standard rate — ADR-0006.
            { kind: 'commission', amount: { amount: 6980, currency: 'EUR' } },
          ],
        },
        difference: { amount: 1206, currency: 'EUR' },
        intervals: [
          { planId: 'standard', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-15' },
          { planId: 'payments_plus', effectiveFrom: '2026-09-15', effectiveTo: null },
        ],
      });

      // The whole point of a preview: the merchant has not bought anything yet.
      const intervals = await currentRateIntervals(db, (subscription as { id: string }).id);
      expect(intervals).toHaveLength(1);
      expect(intervals[0]?.planId).toBe('standard');
    });

    it('shows the derivation of each proposed line, not only its amount', async () => {
      const merchantId = await merchantWithVolume();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes/preview`,
        payload: { planId: 'payments_plus', effectiveFrom: '2026-09-15' },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ proposed: { lines: { derivation: unknown }[] } }>();
      expect(body.proposed.lines[0]?.derivation).toMatchObject({
        formula: 'monthly fee × days in segment ÷ days in period',
        rounding: { exact: '1013.33', applied: 1013 },
      });
    });

    it('refuses a change the timeline cannot accept, before it is committed to', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes/preview`,
        payload: { planId: 'standard' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/plan-change-rejected',
      });
    });

    it('rejects an unknown plan the same way the real change does', async () => {
      const merchantId = await createMerchant();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/subscription/plan-changes/preview`,
        payload: { planId: 'platinum_elite' },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://billing-engine.example/problems/no-such-plan',
      });
    });
  });

  /**
   * The document is generated from the route schemas themselves, so it cannot
   * describe an endpoint the server does not serve, or a shape the serialiser
   * does not produce. These tests guard that property rather than the wording.
   */
  describe('GET /openapi.json', () => {
    interface Operation {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      parameters?: { name: string; in: string; required?: boolean }[];
    }
    interface Document {
      openapi: string;
      paths: Record<string, Record<string, Operation>>;
    }

    async function document(): Promise<Document> {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<Document>();
    }

    it('documents every versioned route', async () => {
      const { paths } = await document();

      expect(Object.keys(paths).sort()).toEqual([
        '/v1/invoices/{invoiceId}',
        '/v1/merchants',
        '/v1/merchants/{merchantId}',
        '/v1/merchants/{merchantId}/invoices',
        '/v1/merchants/{merchantId}/subscription',
        '/v1/merchants/{merchantId}/subscription/plan-changes',
        '/v1/merchants/{merchantId}/subscription/plan-changes/preview',
        '/v1/merchants/{merchantId}/transactions',
        '/v1/merchants/{merchantId}/wallet',
      ]);
    });

    it('states what every operation answers with, not only what it accepts', async () => {
      const { paths } = await document();

      const silent = Object.entries(paths).flatMap(([path, operations]) =>
        Object.entries(operations)
          .filter(([, operation]) => {
            const success = Object.entries(operation.responses ?? {}).find(([status]) =>
              status.startsWith('2'),
            );
            return success?.[1]?.content?.['application/json']?.schema === undefined;
          })
          .map(([method]) => `${method.toUpperCase()} ${path}`),
      );

      // The whole reason the response schemas were added. A document that lists
      // endpoints without saying what comes back describes a shape the client
      // still has to guess at.
      expect(silent).toEqual([]);
    });

    it('describes failures as problem details', async () => {
      const { paths } = await document();
      const failure = Object.entries(
        paths['/v1/merchants/{merchantId}']?.get?.responses ?? {},
      ).find(([status]) => status.startsWith('4'));

      expect(failure?.[1]?.content?.['application/json']?.schema).toBeDefined();
    });

    it('carries the path parameters through from the params schema', async () => {
      const { paths } = await document();
      const parameters = paths['/v1/invoices/{invoiceId}']?.get?.parameters ?? [];

      expect(parameters).toContainEqual(
        expect.objectContaining({ name: 'invoiceId', in: 'path', required: true }),
      );
    });

    it('serves a page a person can read it in', async () => {
      const response = await app.inject({ method: 'GET', url: '/docs/' });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });
  });
});
