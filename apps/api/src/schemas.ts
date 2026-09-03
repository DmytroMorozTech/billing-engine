/**
 * JSON Schemas for request and response bodies.
 *
 * Fastify validates against these, and they are what the OpenAPI document is
 * generated from — one definition rather than a schema and a doc that drift.
 *
 * The money shape is the load-bearing one: `amount` is `integer`, so a payload
 * carrying `19.99` is rejected at the edge rather than becoming a float three
 * layers in. See ADR-0001.
 */

export const CURRENCY_CODES = ['EUR', 'GBP', 'USD', 'JPY'] as const;
export const CHANNELS = ['in_person', 'online', 'moto'] as const;

export const moneySchema = {
  $id: 'Money',
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: {
    amount: {
      type: 'integer',
      description: 'Integer in the currency minor unit. 1999 is €19.99.',
    },
    currency: { type: 'string', enum: CURRENCY_CODES },
  },
} as const;

export const problemSchema = {
  $id: 'Problem',
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
  },
} as const;

export const createMerchantBody = {
  $id: 'CreateMerchantBody',
  type: 'object',
  required: ['email', 'name', 'marketId', 'billingTimeZone'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 320 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    marketId: { type: 'string', enum: ['DE', 'GB', 'IT'] },
    billingTimeZone: { type: 'string', minLength: 1, maxLength: 64 },
    vatId: { type: 'string', maxLength: 20, nullable: true },
    planId: { type: 'string', default: 'standard' },
  },
} as const;

export const merchantResponse = {
  $id: 'Merchant',
  type: 'object',
  required: ['id', 'email', 'name', 'marketId', 'billingTimeZone', 'currency', 'subscriptionId'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    marketId: { type: 'string' },
    billingTimeZone: { type: 'string' },
    currency: { type: 'string' },
    vatId: { type: 'string', nullable: true },
    subscriptionId: { type: 'string' },
    planId: { type: 'string' },
  },
} as const;

export const ingestTransactionBody = {
  $id: 'IngestTransactionBody',
  type: 'object',
  required: ['gross', 'channel', 'occurredAt'],
  additionalProperties: false,
  properties: {
    gross: { $ref: 'Money#' },
    channel: { type: 'string', enum: CHANNELS },
    occurredAt: {
      type: 'string',
      format: 'date-time',
      description: 'The instant the payment happened, in RFC 3339.',
    },
  },
} as const;

export const transactionResponse = {
  $id: 'Transaction',
  type: 'object',
  required: ['id', 'gross', 'channel', 'occurredAt', 'occurredOn'],
  properties: {
    id: { type: 'string' },
    gross: { $ref: 'Money#' },
    channel: { type: 'string' },
    occurredAt: { type: 'string' },
    occurredOn: {
      type: 'string',
      description: 'Local date in the merchant billing time zone, frozen at ingest.',
    },
  },
} as const;

export const changePlanBody = {
  $id: 'ChangePlanBody',
  type: 'object',
  required: ['planId'],
  additionalProperties: false,
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 64 },
    effectiveFrom: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Local date in the merchant billing time zone. Defaults to today.',
    },
  },
} as const;

export const rateIntervalResponse = {
  $id: 'RateInterval',
  type: 'object',
  required: ['id', 'planId', 'effectiveFrom', 'monthlyFee', 'rates'],
  properties: {
    id: { type: 'string' },
    planId: { type: 'string' },
    effectiveFrom: { type: 'string' },
    effectiveTo: { type: 'string', nullable: true },
    monthlyFee: { $ref: 'Money#' },
    rates: {
      type: 'object',
      properties: {
        in_person: { type: 'integer' },
        online: { type: 'integer' },
        moto: { type: 'integer' },
      },
    },
  },
} as const;

export const subscriptionResponse = {
  $id: 'Subscription',
  type: 'object',
  required: ['id', 'anchorDate', 'status', 'currentPeriod', 'intervals'],
  properties: {
    id: { type: 'string' },
    anchorDate: { type: 'string' },
    status: { type: 'string' },
    currentPeriod: {
      type: 'object',
      required: ['start', 'end'],
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
      },
    },
    intervals: { type: 'array', items: { $ref: 'RateInterval#' } },
  },
} as const;

export const planChangeResponse = {
  $id: 'PlanChange',
  type: 'object',
  required: ['backdated', 'intervals'],
  properties: {
    backdated: {
      type: 'boolean',
      description: 'True when the change reaches into a period that may already be billed.',
    },
    intervals: { type: 'array', items: { $ref: 'RateInterval#' } },
  },
} as const;

export const invoiceLineResponse = {
  $id: 'InvoiceLine',
  type: 'object',
  required: ['position', 'kind', 'description', 'amount', 'derivation'],
  properties: {
    position: { type: 'integer' },
    kind: { type: 'string' },
    description: { type: 'string' },
    amount: { $ref: 'Money#' },
    vatRateBps: { type: 'integer' },
    derivation: {
      type: 'object',
      additionalProperties: true,
      description:
        'How the amount was reached. Recorded when it was computed, never regenerated.',
    },
  },
} as const;

export const invoiceResponse = {
  $id: 'Invoice',
  type: 'object',
  required: ['id', 'status', 'periodStart', 'periodEnd', 'subtotal', 'vat', 'total', 'lines'],
  properties: {
    id: { type: 'string' },
    number: { type: 'string', nullable: true },
    status: { type: 'string' },
    periodStart: { type: 'string' },
    periodEnd: { type: 'string' },
    subtotal: { $ref: 'Money#' },
    vat: { $ref: 'Money#' },
    total: { $ref: 'Money#' },
    lines: { type: 'array', items: { $ref: 'InvoiceLine#' } },
  },
} as const;

export const walletResponse = {
  $id: 'Wallet',
  type: 'object',
  required: ['accountKey', 'balance'],
  properties: {
    accountKey: { type: 'string' },
    balance: { $ref: 'Money#' },
  },
} as const;

/** Registered once at boot so `$ref` works across route schemas. */
export const sharedSchemas = [
  moneySchema,
  problemSchema,
  createMerchantBody,
  merchantResponse,
  ingestTransactionBody,
  transactionResponse,
  changePlanBody,
  rateIntervalResponse,
  subscriptionResponse,
  planChangeResponse,
  invoiceLineResponse,
  invoiceResponse,
  walletResponse,
];
