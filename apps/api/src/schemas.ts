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

/**
 * Path parameters.
 *
 * Ids are UUID columns, so an unparseable one reaches PostgreSQL as a type
 * error and comes back as a 500 — our failure, reported for their typo. The
 * shape of an id is knowable without a query, so it is checked here instead.
 */
export const merchantParams = {
  $id: 'MerchantParams',
  type: 'object',
  required: ['merchantId'],
  properties: { merchantId: { type: 'string', format: 'uuid' } },
} as const;

export const invoiceParams = {
  $id: 'InvoiceParams',
  type: 'object',
  required: ['invoiceId'],
  properties: { invoiceId: { type: 'string', format: 'uuid' } },
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

/**
 * Why the VAT is what it is, not only how much.
 *
 * Two of the three kinds carry a rate of zero and they are different in law, so
 * a client showing "no VAT" has something to say about which one applied.
 */
export const vatTreatmentResponse = {
  $id: 'VatTreatment',
  type: 'object',
  required: ['kind', 'rateBps'],
  properties: {
    kind: { type: 'string', enum: ['standard', 'reverse_charge', 'outside_scope'] },
    rateBps: {
      type: 'integer',
      description: 'Basis points. 1900 is 19%. Zero for both non-standard treatments.',
    },
  },
} as const;

export const merchantDetailResponse = {
  $id: 'MerchantDetail',
  type: 'object',
  required: ['id', 'email', 'name', 'marketId', 'billingTimeZone', 'currency', 'vatTreatment'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    marketId: { type: 'string' },
    legalEntityId: { type: 'string' },
    billingTimeZone: { type: 'string' },
    currency: { type: 'string', enum: CURRENCY_CODES },
    vatId: { type: 'string', nullable: true },
    vatTreatment: { $ref: 'VatTreatment#' },
    // Null for a merchant whose subscription has been cancelled. They still
    // exist, still have invoices, and a client still has to render them.
    subscription: {
      type: 'object',
      nullable: true,
      required: ['id', 'status', 'anchorDate', 'currentPeriod'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'past_due', 'suspended', 'cancelled'] },
        anchorDate: { type: 'string' },
        planId: { type: 'string', nullable: true },
        currentPeriod: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
          },
        },
      },
    },
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

/** One priced period: the shape of an invoice that has not been issued. */
export const pricedPeriodResponse = {
  $id: 'PricedPeriod',
  type: 'object',
  required: ['subtotal', 'vat', 'total', 'lines'],
  properties: {
    subtotal: { $ref: 'Money#' },
    vat: { $ref: 'Money#' },
    total: { $ref: 'Money#' },
    vatTreatment: { type: 'string', enum: ['standard', 'reverse_charge', 'outside_scope'] },
    lines: { type: 'array', items: { $ref: 'InvoiceLine#' } },
  },
} as const;

/**
 * What a plan change would cost, computed and discarded.
 *
 * Both sides of the comparison, because the question a merchant is actually
 * asking is "what does this change do to my bill", and a single new total does
 * not answer it. The arithmetic is the billing calculation itself — the same
 * `buildInvoice` the run uses — so a preview cannot promise one thing and the
 * invoice charge another.
 */
export const planChangePreviewResponse = {
  $id: 'PlanChangePreview',
  type: 'object',
  required: ['backdated', 'period', 'current', 'proposed', 'difference', 'intervals'],
  properties: {
    backdated: {
      type: 'boolean',
      description: 'True when the change reaches into a period that may already be billed.',
    },
    period: {
      type: 'object',
      required: ['start', 'end'],
      properties: { start: { type: 'string' }, end: { type: 'string' } },
    },
    current: { $ref: 'PricedPeriod#' },
    proposed: { $ref: 'PricedPeriod#' },
    difference: {
      $ref: 'Money#',
      description: 'Proposed total less current total. Negative when the change saves money.',
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
      // Load-bearing. With this false, or simply absent, the serialiser emits
      // `{}` for every derivation and "why this amount" stops being answerable.
      additionalProperties: true,
      description:
        'How the amount was reached. Recorded when it was computed, never regenerated.',
    },
  },
} as const;

export const paymentAttemptResponse = {
  $id: 'PaymentAttempt',
  type: 'object',
  required: ['attempt', 'status', 'attemptedAt'],
  properties: {
    attempt: { type: 'integer', description: 'One-based. The dunning sequence allows four.' },
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    declineCode: { type: 'string', nullable: true },
    pspChargeId: { type: 'string' },
    attemptedAt: { type: 'string' },
  },
} as const;

export const creditNoteSummaryResponse = {
  $id: 'CreditNoteSummary',
  type: 'object',
  required: ['id', 'number', 'total', 'issuedOn'],
  properties: {
    id: { type: 'string' },
    number: { type: 'string' },
    /** Negative: a credit note reduces what is owed. */
    total: { $ref: 'Money#' },
    issuedOn: { type: 'string' },
  },
} as const;

export const invoiceResponse = {
  $id: 'Invoice',
  type: 'object',
  required: [
    'id',
    'status',
    'periodStart',
    'periodEnd',
    'subtotal',
    'vat',
    'total',
    'netTotal',
    'lines',
    'paymentAttempts',
    'creditNotes',
  ],
  properties: {
    id: { type: 'string' },
    number: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['draft', 'open', 'paid', 'uncollectible', 'void'] },
    periodStart: { type: 'string' },
    periodEnd: { type: 'string' },
    issuedOn: { type: 'string', nullable: true },
    dueOn: { type: 'string', nullable: true },
    // The kind as it was stored when the invoice was issued, not recomputed
    // from the merchant: they may have moved market since, and the invoice was
    // issued under the rule that applied then. The rate is on each line.
    vatTreatment: { type: 'string', enum: ['standard', 'reverse_charge', 'outside_scope'] },
    subtotal: { $ref: 'Money#' },
    vat: { $ref: 'Money#' },
    total: { $ref: 'Money#' },
    netTotal: {
      $ref: 'Money#',
      description:
        'The total less any credit notes issued against it. Equal to `total` until one is.',
    },
    lines: { type: 'array', items: { $ref: 'InvoiceLine#' } },
    // The dunning history. Without it the invoice says how much is owed but
    // not why a merchant has been suspended over it.
    paymentAttempts: { type: 'array', items: { $ref: 'PaymentAttempt#' } },
    creditNotes: { type: 'array', items: { $ref: 'CreditNoteSummary#' } },
  },
} as const;

export const invoiceSummaryResponse = {
  $id: 'InvoiceSummary',
  type: 'object',
  required: ['id', 'number', 'status', 'periodStart', 'periodEnd', 'total'],
  properties: {
    id: { type: 'string' },
    number: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['draft', 'open', 'paid', 'uncollectible', 'void'] },
    periodStart: { type: 'string' },
    periodEnd: { type: 'string' },
    issuedOn: { type: 'string', nullable: true },
    dueOn: { type: 'string', nullable: true },
    total: { $ref: 'Money#' },
  },
} as const;

/**
 * Wrapped rather than a bare array, so a cursor can be added later without
 * changing the shape every client has already parsed.
 */
export const invoiceListResponse = {
  $id: 'InvoiceList',
  type: 'object',
  required: ['invoices'],
  properties: {
    invoices: { type: 'array', items: { $ref: 'InvoiceSummary#' } },
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
  merchantParams,
  invoiceParams,
  createMerchantBody,
  merchantResponse,
  vatTreatmentResponse,
  merchantDetailResponse,
  ingestTransactionBody,
  transactionResponse,
  changePlanBody,
  rateIntervalResponse,
  subscriptionResponse,
  planChangeResponse,
  invoiceLineResponse,
  pricedPeriodResponse,
  planChangePreviewResponse,
  paymentAttemptResponse,
  creditNoteSummaryResponse,
  invoiceResponse,
  invoiceSummaryResponse,
  invoiceListResponse,
  walletResponse,
];
