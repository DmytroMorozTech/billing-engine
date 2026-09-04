import type { Database, MerchantContext, SubscriptionContext } from '@billing/db';
import {
  applyPlanChange,
  attemptsFor,
  claimKey,
  creditNotesFor,
  createMerchant,
  createSubscription,
  currentRateIntervals,
  ensureMerchantAccounts,
  findPlanTerms,
  ingestTransaction,
  InvalidTimeZoneError,
  invoiceLines,
  invoicesFor,
  liveSubscription,
  merchantContext,
  netCharged,
  openInitialInterval,
  recordResponse,
  uninvoicedInPeriod,
  vatTreatmentFor,
} from '@billing/db';
import type {
  Channel,
  Clock,
  CurrencyCode,
  InvoiceDraft,
  RateInterval,
} from '@billing/domain';
import {
  buildInvoice,
  currentPeriod,
  money,
  PlanChangeError,
  preparePlanChange,
  subtract,
  todayIn,
} from '@billing/domain';
import type { IdGenerator } from '@billing/platform';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { Temporal } from 'temporal-polyfill';

import { PROBLEM_CONTENT_TYPE, ProblemError, problems } from './problem.js';
import { sharedSchemas } from './schemas.js';

export interface ApiDependencies {
  db: Kysely<Database>;
  /** Injected, always. Nothing here reads ambient time — ADR-0002. */
  clock: Clock;
  ids: IdGenerator;
  logger?: boolean;
}

interface HandlerResult<T> {
  status: number;
  body: T;
}

/**
 * Runs a write inside one transaction, protected by an idempotency key.
 *
 * The key row and the effect commit together, which is the whole reason the
 * keys live in PostgreSQL and not Redis (ADR-0004). A replay returns the
 * original response rather than a conflict: a client that retried because it
 * never saw the first response needs the result, not an error. The same data,
 * though not necessarily the same bytes — see `claimKey`.
 */
async function withIdempotency<T>(
  deps: ApiDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  run: (tx: Transaction<Database>) => Promise<HandlerResult<T>>,
): Promise<void> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim() === '') {
    throw problems.missingIdempotencyKey();
  }

  const outcome = await deps.db.transaction().execute(async (tx) => {
    const claim = await claimKey(tx, key, endpoint, request.body ?? null);

    if (claim.outcome === 'conflict') {
      return { kind: 'conflict' as const };
    }
    if (claim.outcome === 'replay') {
      return { kind: 'replay' as const, response: claim.response };
    }

    const result = await run(tx);
    await recordResponse(tx, key, { status: result.status, body: result.body });
    return { kind: 'fresh' as const, result };
  });

  if (outcome.kind === 'conflict') {
    throw problems.idempotencyKeyReused(key);
  }

  if (outcome.kind === 'replay') {
    // Says the work was not repeated, without changing the body.
    await reply
      .header('Idempotency-Replayed', 'true')
      .status(outcome.response.status)
      .send(outcome.response.body);
    return;
  }

  await reply.status(outcome.result.status).send(outcome.result.body);
}

function intervalResponse(interval: RateInterval) {
  return {
    id: interval.id,
    planId: interval.planId,
    effectiveFrom: interval.effectiveFrom.toString(),
    effectiveTo: interval.effectiveTo?.toString() ?? null,
    monthlyFee: interval.monthlyFee,
    rates: interval.rates,
  };
}

/**
 * The interval in force on a date, from the timeline as we currently believe it.
 *
 * Not simply the open-ended one: a merchant who has scheduled an upgrade for
 * next week is still on the old plan today, and telling them otherwise on their
 * dashboard would be a lie they could check.
 */
function intervalOn(
  intervals: readonly RateInterval[],
  date: Temporal.PlainDate,
): RateInterval | undefined {
  return intervals.find(
    (interval) =>
      Temporal.PlainDate.compare(interval.effectiveFrom, date) <= 0 &&
      (interval.effectiveTo === null ||
        Temporal.PlainDate.compare(interval.effectiveTo, date) > 0),
  );
}

/**
 * A draft invoice as the API renders it.
 *
 * Shared by the preview and, in shape, by the issued invoice: a merchant
 * comparing the two is comparing like with like, which is the only way the
 * preview is worth anything.
 */
function pricedPeriod(draft: InvoiceDraft) {
  return {
    subtotal: draft.subtotal,
    vat: draft.vat,
    total: draft.total,
    vatTreatment: draft.vatTreatment,
    lines: draft.lines.map((line, position) => ({
      position,
      kind: line.kind,
      description: line.description,
      amount: line.amount,
      vatRateBps: line.vatRateBps,
      derivation: line.derivation,
    })),
  };
}

async function subscriptionSummary(
  deps: ApiDependencies,
  merchant: MerchantContext,
  subscription: SubscriptionContext,
) {
  const today = todayIn(deps.clock, merchant.billingTimeZone);
  const period = currentPeriod(subscription.anchorDate, deps.clock, merchant.billingTimeZone);
  const intervals = await currentRateIntervals(deps.db, subscription.id);

  return {
    id: subscription.id,
    status: subscription.status,
    anchorDate: subscription.anchorDate.toString(),
    planId: intervalOn(intervals, today)?.planId ?? null,
    currentPeriod: { start: period.start.toString(), end: period.end.toString() },
  };
}

/**
 * Builds the server.
 *
 * Async because the OpenAPI plugins have to finish loading before the first
 * route is declared — they collect routes through an `onRoute` hook, and a hook
 * that has not been installed yet sees nothing. Registering them without
 * awaiting produces a document with an empty `paths`, which is worse than no
 * document because it looks like it worked.
 */
export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => deps.ids.next(),
  });

  for (const schema of sharedSchemas) {
    app.addSchema(schema);
  }

  // Read from the route schemas rather than written alongside them. A document
  // maintained by hand describes the API someone remembered building, and the
  // gap opens on the first change nobody thought to write down.
  //
  // Registered synchronously, so `buildServer` stays a plain function and every
  // caller keeps working without awaiting. Fastify queues the plugin and
  // `app.ready()` resolves it, which the tests and `main.ts` already await.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Billing engine',
        version: '1.0.0',
        description:
          'Subscriptions, usage-based commission and invoicing for a small-business ' +
          'payments platform.\n\n' +
          'Money is always an integer in the currency minor unit: 1999 is EUR 19.99. ' +
          'There are no floats anywhere in this API, on purpose (ADR-0001).\n\n' +
          'Every write endpoint requires an `Idempotency-Key` header. A retry with ' +
          'the same key returns the original response and does not repeat the work; ' +
          'reusing a key for a different body is a 422 (ADR-0004).\n\n' +
          'Failures are RFC 9457 problem documents, including the ones Fastify ' +
          'raises itself. Branch on `type`, which is stable; `detail` is prose for ' +
          'a human and may be reworded.',
      },
      servers: [{ url: '/', description: 'This server' }],
      tags: [
        { name: 'merchants', description: 'Onboarding, market and VAT treatment' },
        { name: 'subscriptions', description: 'Plans, rate timeline and proration' },
        { name: 'invoices', description: 'Issued documents, dunning and corrections' },
        { name: 'transactions', description: 'Processed volume' },
        { name: 'wallet', description: 'Balance, derived from the ledger' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    // Assets are served from the package, not a CDN, so the documentation works
    // offline and inside docker-compose with no network.
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // The plugin builds the document but serves it only under the UI's own
  // prefix. A generator or a client fetching the spec should not have to know
  // where the human-readable page happens to live, so it gets a stable path of
  // its own. Hidden from the document it returns: it is not part of the API
  // being described.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  /**
   * Every failure leaves as RFC 9457, including the ones Fastify raises itself.
   * A client should never have to tell our error shape from the framework's.
   */
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const instance = request.url;

    if (error instanceof ProblemError) {
      void reply.status(error.status).type(PROBLEM_CONTENT_TYPE).send(error.toProblem(instance));
      return;
    }

    if (error.validation) {
      const problem = problems.validation(error.message);
      void reply.status(400).type(PROBLEM_CONTENT_TYPE).send(problem.toProblem(instance));
      return;
    }

    if (error instanceof InvalidTimeZoneError) {
      const problem = problems.unprocessable('Unknown time zone', error.message);
      void reply.status(422).type(PROBLEM_CONTENT_TYPE).send(problem.toProblem(instance));
      return;
    }

    if (error instanceof PlanChangeError) {
      const problem = problems.planChangeRejected(error.message);
      void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem.toProblem(instance));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    void reply.status(500).type(PROBLEM_CONTENT_TYPE).send(problems.internal().toProblem(instance));
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = new ProblemError(
      404,
      'no-such-route',
      'No such route',
      `${request.method} ${request.url} is not a route on this API`,
    );
    void reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem.toProblem(request.url));
  });

  // Touches the database on purpose: a process that is up but cannot reach
  // PostgreSQL is not healthy, and saying otherwise wastes an on-call hour.
  app.get('/health', { schema: { hide: true } }, async () => {
    await deps.db.selectFrom('currencies').select('code').limit(1).execute();
    return { status: 'ok' };
  });

  app.post(
    '/v1/merchants',
    {
      schema: {
        tags: ['merchants'],
        summary: 'Onboard a merchant on a plan',
        body: { $ref: 'CreateMerchantBody#' },
        response: { 201: { $ref: 'Merchant#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        name: string;
        marketId: string;
        billingTimeZone: string;
        vatId?: string | null;
        planId?: string;
      };

      await withIdempotency(deps, request, reply, 'POST /v1/merchants', async (tx) => {
        const merchantId = deps.ids.next();
        const subscriptionId = deps.ids.next();
        const planId = body.planId ?? 'standard';
        const anchor = deps.clock.now().withTimeZone(body.billingTimeZone).toPlainDate();

        await createMerchant(tx, {
          id: merchantId,
          legalEntityId: 'de-gmbh',
          marketId: body.marketId,
          currency: 'EUR',
          email: body.email,
          name: body.name,
          billingTimeZone: body.billingTimeZone,
          vatId: body.vatId ?? null,
        });
        await createSubscription(tx, {
          id: subscriptionId,
          merchantId,
          anchorDate: anchor,
        });
        await ensureMerchantAccounts(tx, merchantId, 'EUR');

        const terms = await findPlanTerms(tx, planId);
        if (!terms) {
          throw problems.noSuchPlan(planId);
        }

        await openInitialInterval(tx, subscriptionId, {
          ...terms,
          id: deps.ids.next(),
          effectiveFrom: anchor,
          effectiveTo: null,
        });

        return {
          status: 201,
          body: {
            id: merchantId,
            email: body.email,
            name: body.name,
            marketId: body.marketId,
            billingTimeZone: body.billingTimeZone,
            currency: 'EUR',
            vatId: body.vatId ?? null,
            subscriptionId,
            planId,
          },
        };
      });
    },
  );

  app.post(
    '/v1/merchants/:merchantId/transactions',
    {
      schema: {
        tags: ['transactions'],
        summary: 'Record processed volume',
        params: { $ref: 'MerchantParams#' },
        body: { $ref: 'IngestTransactionBody#' },
        response: { 201: { $ref: 'Transaction#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request, reply) => {
      const { merchantId } = request.params as { merchantId: string };
      const body = request.body as {
        gross: { amount: number; currency: CurrencyCode };
        channel: Channel;
        occurredAt: string;
      };

      // The merchant is part of the idempotency scope. Two merchants can
      // legitimately send the same amount on the same channel at the same
      // instant, and a shared scope would replay one merchant's response to
      // the other.
      await withIdempotency(
        deps,
        request,
        reply,
        `POST /v1/merchants/${merchantId}/transactions`,
        async (tx) => {
          const merchant = await merchantContext(tx, merchantId).catch(() => undefined);
          if (!merchant) {
            throw problems.notFound('merchant', merchantId);
          }

          const id = deps.ids.next();
          const occurredAt = Temporal.Instant.from(body.occurredAt);
          const occurredOn = await ingestTransaction(
            tx,
            {
              id,
              merchantId,
              gross: money(body.gross.amount, body.gross.currency),
              channel: body.channel,
              occurredAt,
            },
            merchant.billingTimeZone,
          );

          return {
            status: 201,
            body: {
              id,
              gross: body.gross,
              channel: body.channel,
              occurredAt: occurredAt.toString(),
              occurredOn: occurredOn.toString(),
            },
          };
        },
      );
    },
  );

  app.get(
    '/v1/merchants/:merchantId',
    {
      schema: {
        tags: ['merchants'],
        summary: 'Market, VAT treatment and subscription state',
        params: { $ref: 'MerchantParams#' },
        response: { 200: { $ref: 'MerchantDetail#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { merchantId } = request.params as { merchantId: string };

      const row = await deps.db
        .selectFrom('merchants')
        .select(['id', 'email', 'name'])
        .where('id', '=', merchantId)
        .executeTakeFirst();
      if (!row) {
        throw problems.notFound('merchant', merchantId);
      }

      // The treatment rather than the rate alone: the answer to "why is there
      // no VAT on my invoice" is a kind, and it is decided from the merchant's
      // market and VAT id together.
      const merchant = await merchantContext(deps.db, merchantId);
      const treatment = vatTreatmentFor(merchant);

      const subscription = await liveSubscription(deps.db, merchantId);

      return {
        id: merchant.id,
        email: row.email,
        name: row.name,
        marketId: merchant.marketId,
        legalEntityId: merchant.legalEntityId,
        billingTimeZone: merchant.billingTimeZone,
        currency: merchant.currency,
        vatId: merchant.vatId,
        vatTreatment: { kind: treatment.kind, rateBps: treatment.rateBps },
        subscription: subscription ? await subscriptionSummary(deps, merchant, subscription) : null,
      };
    },
  );

  app.get(
    '/v1/merchants/:merchantId/invoices',
    {
      schema: {
        tags: ['invoices'],
        summary: 'Invoices of a merchant, most recent period first',
        params: { $ref: 'MerchantParams#' },
        response: { 200: { $ref: 'InvoiceList#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { merchantId } = request.params as { merchantId: string };

      // Checked rather than inferred from an empty list. "This merchant has no
      // invoices" and "there is no such merchant" are different answers, and a
      // client that cannot tell them apart shows an empty table for a typo.
      const merchant = await deps.db
        .selectFrom('merchants')
        .select('id')
        .where('id', '=', merchantId)
        .executeTakeFirst();
      if (!merchant) {
        throw problems.notFound('merchant', merchantId);
      }

      return { invoices: await invoicesFor(deps.db, merchantId) };
    },
  );

  app.get(
    '/v1/merchants/:merchantId/subscription',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Anchor date, current period and rate timeline',
        params: { $ref: 'MerchantParams#' },
        response: { 200: { $ref: 'Subscription#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { merchantId } = request.params as { merchantId: string };

      const merchant = await deps.db
        .selectFrom('merchants')
        .select(['id', 'billing_time_zone'])
        .where('id', '=', merchantId)
        .executeTakeFirst();
      if (!merchant) {
        throw problems.notFound('merchant', merchantId);
      }

      const subscription = await deps.db
        .selectFrom('subscriptions')
        .select(['id', 'anchor_date', 'status'])
        .where('merchant_id', '=', merchantId)
        .where('status', '!=', 'cancelled')
        .executeTakeFirst();
      if (!subscription) {
        throw problems.notFound('live subscription for merchant', merchantId);
      }

      const anchor = Temporal.PlainDate.from(subscription.anchor_date);
      const period = currentPeriod(anchor, deps.clock, merchant.billing_time_zone);
      const intervals = await currentRateIntervals(deps.db, subscription.id);

      return {
        id: subscription.id,
        anchorDate: subscription.anchor_date,
        status: subscription.status,
        currentPeriod: { start: period.start.toString(), end: period.end.toString() },
        intervals: intervals.map(intervalResponse),
      };
    },
  );

  app.post(
    '/v1/merchants/:merchantId/subscription/plan-changes',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Change plan, prospectively or backdated',
        params: { $ref: 'MerchantParams#' },
        body: { $ref: 'ChangePlanBody#' },
        response: { 200: { $ref: 'PlanChange#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request, reply) => {
      const { merchantId } = request.params as { merchantId: string };
      const body = request.body as { planId: string; effectiveFrom?: string };

      await withIdempotency(
        deps,
        request,
        reply,
        `POST /v1/merchants/${merchantId}/subscription/plan-changes`,
        async (tx) => {
          const merchant = await merchantContext(tx, merchantId).catch(() => undefined);
          if (!merchant) {
            throw problems.notFound('merchant', merchantId);
          }
          const subscription = await liveSubscription(tx, merchantId);
          if (!subscription) {
            throw problems.notFound('live subscription for merchant', merchantId);
          }

          // "Today" is the merchant's, not the server's: it decides whether
          // this change is new information or a correction of the past.
          const today = todayIn(deps.clock, merchant.billingTimeZone);
          const effectiveFrom =
            body.effectiveFrom === undefined
              ? today
              : Temporal.PlainDate.from(body.effectiveFrom);

          const newTerms = await findPlanTerms(tx, body.planId);
          if (!newTerms) {
            throw problems.noSuchPlan(body.planId);
          }

          const plan = preparePlanChange({
            currentIntervals: await currentRateIntervals(tx, subscription.id),
            newTerms,
            effectiveFrom,
            today,
            nextId: () => deps.ids.next(),
          });

          await applyPlanChange(tx, subscription.id, plan);

          return {
            status: 200,
            body: {
              backdated: plan.backdated,
              intervals: plan.resulting.map(intervalResponse),
            },
          };
        },
      );
    },
  );

  /**
   * What a plan change would cost, without making it.
   *
   * A POST because it carries a body, and deliberately without an
   * Idempotency-Key: nothing is written, so there is no repeated effect for a
   * key to protect against, and demanding one would be ceremony a client has
   * to satisfy for no benefit.
   *
   * The arithmetic is `preparePlanChange` and `buildInvoice` — the same two
   * functions the real change and the billing run use. A preview computed by a
   * second implementation would eventually promise a number the invoice does
   * not charge, and the merchant would be right to complain.
   */
  app.post(
    '/v1/merchants/:merchantId/subscription/plan-changes/preview',
    {
      schema: {
        tags: ['subscriptions'],
        summary: 'Price a plan change without making it',
        description:
          'Writes nothing, and needs no Idempotency-Key. Returns the current period ' +
          'priced both ways so the difference is visible before committing.',
        params: { $ref: 'MerchantParams#' },
        body: { $ref: 'ChangePlanBody#' },
        response: { 200: { $ref: 'PlanChangePreview#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { merchantId } = request.params as { merchantId: string };
      const body = request.body as { planId: string; effectiveFrom?: string };

      const exists = await deps.db
        .selectFrom('merchants')
        .select('id')
        .where('id', '=', merchantId)
        .executeTakeFirst();
      if (!exists) {
        throw problems.notFound('merchant', merchantId);
      }

      const merchant = await merchantContext(deps.db, merchantId);
      const subscription = await liveSubscription(deps.db, merchantId);
      if (!subscription) {
        throw problems.notFound('live subscription for merchant', merchantId);
      }

      const newTerms = await findPlanTerms(deps.db, body.planId);
      if (!newTerms) {
        throw problems.noSuchPlan(body.planId);
      }

      // "Today" is the merchant's. It decides whether the change is new
      // information or a correction, and the answer changes the arithmetic.
      const today = todayIn(deps.clock, merchant.billingTimeZone);
      const effectiveFrom =
        body.effectiveFrom === undefined ? today : Temporal.PlainDate.from(body.effectiveFrom);

      const currentIntervals = await currentRateIntervals(deps.db, subscription.id);

      // Rejections surface here, before the merchant commits — which is most of
      // the value of asking. Already on the plan, or a date before the
      // subscription began, leaves as the same 422 the real change gives.
      const plan = preparePlanChange({
        currentIntervals,
        newTerms,
        effectiveFrom,
        today,
        // The ids appear in the previewed timeline and are then thrown away.
        // Generated anyway so the shape matches what applying it would return.
        nextId: () => deps.ids.next(),
      });

      const period = currentPeriod(subscription.anchorDate, deps.clock, merchant.billingTimeZone);
      const transactions = await uninvoicedInPeriod(deps.db, merchantId, period);
      const vat = vatTreatmentFor(merchant);

      const price = (intervals: readonly RateInterval[]) =>
        buildInvoice({ period, currency: merchant.currency, intervals, transactions, vat });

      const current = price(currentIntervals);
      const proposed = price(plan.resulting);

      return {
        backdated: plan.backdated,
        period: { start: period.start.toString(), end: period.end.toString() },
        current: pricedPeriod(current),
        proposed: pricedPeriod(proposed),
        difference: subtract(proposed.total, current.total),
        intervals: plan.resulting.map(intervalResponse),
      };
    },
  );

  app.get(
    '/v1/invoices/:invoiceId',
    {
      schema: {
        tags: ['invoices'],
        summary: 'One invoice, with its derivations, dunning history and credit notes',
        params: { $ref: 'InvoiceParams#' },
        response: { 200: { $ref: 'Invoice#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { invoiceId } = request.params as { invoiceId: string };

      const invoice = await deps.db
        .selectFrom('invoices')
        .select([
          'id',
          'number',
          'status',
          'period_start',
          'period_end',
          'issued_on',
          'due_on',
          'currency',
          'vat_treatment',
          'subtotal_minor',
          'vat_minor',
          'total_minor',
        ])
        .where('id', '=', invoiceId)
        .executeTakeFirst();
      if (!invoice) {
        throw problems.notFound('invoice', invoiceId);
      }

      const [lines, attempts, creditNotes, net] = await Promise.all([
        invoiceLines(deps.db, invoiceId),
        attemptsFor(deps.db, invoiceId),
        creditNotesFor(deps.db, invoiceId),
        netCharged(deps.db, invoiceId),
      ]);

      return {
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        issuedOn: invoice.issued_on,
        dueOn: invoice.due_on,
        // Stored on the invoice, not recomputed from the merchant. The merchant
        // may have moved market since; the invoice was issued under the rule
        // that applied then.
        vatTreatment: invoice.vat_treatment,
        subtotal: { amount: invoice.subtotal_minor, currency: invoice.currency },
        vat: { amount: invoice.vat_minor, currency: invoice.currency },
        total: { amount: invoice.total_minor, currency: invoice.currency },
        netTotal: net.total,
        paymentAttempts: attempts.map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
          declineCode: attempt.declineCode,
          pspChargeId: attempt.pspChargeId,
          attemptedAt: attempt.attemptedAt.toISOString(),
        })),
        creditNotes: creditNotes.map((note) => ({
          id: note.id,
          number: note.number,
          total: { amount: note.totalMinor, currency: invoice.currency },
          issuedOn: note.issuedOn,
        })),
        lines: lines.map((line) => ({
          position: line.position,
          kind: line.kind,
          description: line.description,
          amount: { amount: line.amountMinor, currency: invoice.currency },
          vatRateBps: line.vatRateBps,
          // Returned as recorded. Never regenerated on read, so it cannot drift
          // away from the amount it explains.
          derivation: line.derivation,
        })),
      };
    },
  );

  app.get(
    '/v1/merchants/:merchantId/wallet',
    {
      schema: {
        tags: ['wallet'],
        summary: 'Balance, derived from the ledger rather than stored',
        params: { $ref: 'MerchantParams#' },
        response: { 200: { $ref: 'Wallet#' }, '4xx': { $ref: 'Problem#' } },
      },
    },
    async (request) => {
      const { merchantId } = request.params as { merchantId: string };
      const merchant = await merchantContext(deps.db, merchantId).catch(() => undefined);
      if (!merchant) {
        throw problems.notFound('merchant', merchantId);
      }

      const { balance, merchantWalletKey } = await import('@billing/db');
      const accountKey = merchantWalletKey(merchantId);

      return {
        accountKey,
        balance: await balance(deps.db, accountKey, merchant.currency),
      };
    },
  );

  return app;
}
