import type { Database } from '@billing/db';
import {
  applyPlanChange,
  claimKey,
  createMerchant,
  createSubscription,
  currentRateIntervals,
  ensureMerchantAccounts,
  findPlanTerms,
  ingestTransaction,
  InvalidTimeZoneError,
  invoiceLines,
  liveSubscription,
  merchantContext,
  openInitialInterval,
  recordResponse,
} from '@billing/db';
import type { Channel, Clock, CurrencyCode, RateInterval } from '@billing/domain';
import { currentPeriod, money, PlanChangeError, preparePlanChange, todayIn } from '@billing/domain';
import type { IdGenerator } from '@billing/platform';
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
 * original response verbatim rather than a conflict: a client that retried
 * because it never saw the first response needs the result, not an error.
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

export function buildServer(deps: ApiDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => deps.ids.next(),
  });

  for (const schema of sharedSchemas) {
    app.addSchema(schema);
  }

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
  app.get('/health', async () => {
    await deps.db.selectFrom('currencies').select('code').limit(1).execute();
    return { status: 'ok' };
  });

  app.post(
    '/v1/merchants',
    { schema: { body: { $ref: 'CreateMerchantBody#' } } },
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
    { schema: { body: { $ref: 'IngestTransactionBody#' } } },
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

  app.get('/v1/merchants/:merchantId/subscription', async (request) => {
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
  });

  app.post(
    '/v1/merchants/:merchantId/subscription/plan-changes',
    { schema: { body: { $ref: 'ChangePlanBody#' } } },
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

  app.get('/v1/invoices/:invoiceId', async (request) => {
    const { invoiceId } = request.params as { invoiceId: string };

    const invoice = await deps.db
      .selectFrom('invoices')
      .select([
        'id',
        'number',
        'status',
        'period_start',
        'period_end',
        'currency',
        'subtotal_minor',
        'vat_minor',
        'total_minor',
      ])
      .where('id', '=', invoiceId)
      .executeTakeFirst();
    if (!invoice) {
      throw problems.notFound('invoice', invoiceId);
    }

    const lines = await invoiceLines(deps.db, invoiceId);

    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      subtotal: { amount: invoice.subtotal_minor, currency: invoice.currency },
      vat: { amount: invoice.vat_minor, currency: invoice.currency },
      total: { amount: invoice.total_minor, currency: invoice.currency },
      lines: lines.map((line) => ({
        position: line.position,
        kind: line.kind,
        description: line.description,
        amount: { amount: line.amountMinor, currency: invoice.currency },
        // Returned as recorded. Never regenerated on read, so it cannot drift
        // away from the amount it explains.
        derivation: line.derivation,
      })),
    };
  });

  app.get('/v1/merchants/:merchantId/wallet', async (request) => {
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
  });

  return app;
}
