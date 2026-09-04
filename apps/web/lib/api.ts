/**
 * The one place the frontend talks to the billing API.
 *
 * Server-side only. The browser never reaches the API directly, so there is
 * exactly one place where the base URL, error mapping and — once it exists —
 * the session token live.
 *
 * Types are hand-written for now. The API publishes an OpenAPI 3.1 document at
 * `/openapi.json` generated from the route schemas, so these can be generated
 * from it rather than maintained; that is a decision worth making deliberately
 * rather than by drifting into it.
 */

const BASE_URL = process.env.BILLING_API_URL ?? 'http://localhost:8081';

export interface Money {
  /** Integer in the currency minor unit. 1999 is €19.99. */
  amount: number;
  currency: string;
}

/**
 * How an amount was reached, as it was recorded when it was computed.
 *
 * Never regenerated on read — an explanation that can drift away from the
 * amount it explains is worse than none, because it still looks authoritative.
 */
export interface Derivation {
  result: Money;
  formula: string;
  rounding?: {
    mode: string;
    /** The value before rounding, as a decimal string. Never a float. */
    exact: string;
    applied: number;
  };
  inputs: DerivationNode[];
}

export type DerivationNode =
  | { kind: 'value'; label: string; value: Money | number | string }
  | {
      kind: 'event';
      label: string;
      eventId: string;
      /** When it happened. */
      occurredAt: string;
      /** When we learned of it. The two differ, and the difference matters. */
      recordedAt: string;
    }
  | { kind: 'computation'; label: string; derivation: Derivation };

export interface InvoiceLine {
  position: number;
  kind: 'subscription' | 'commission' | 'proration_credit' | 'adjustment';
  description: string;
  amount: Money;
  vatRateBps: number;
  derivation: Derivation;
}

export interface PaymentAttempt {
  attempt: number;
  status: 'succeeded' | 'failed';
  declineCode: string | null;
  pspChargeId: string;
  attemptedAt: string;
}

export interface CreditNoteSummary {
  id: string;
  number: string;
  /** Negative: a credit note reduces what is owed. */
  total: Money;
  issuedOn: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  periodStart: string;
  periodEnd: string;
  issuedOn: string | null;
  dueOn: string | null;
  vatTreatment: 'standard' | 'reverse_charge' | 'outside_scope';
  subtotal: Money;
  vat: Money;
  total: Money;
  /** The total less any credit notes issued against it. */
  netTotal: Money;
  lines: InvoiceLine[];
  paymentAttempts: PaymentAttempt[];
  creditNotes: CreditNoteSummary[];
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  periodStart: string;
  periodEnd: string;
  issuedOn: string | null;
  dueOn: string | null;
  total: Money;
}

export interface MerchantDetail {
  id: string;
  email: string;
  name: string;
  marketId: string;
  billingTimeZone: string;
  currency: string;
  vatId: string | null;
  vatTreatment: {
    kind: 'standard' | 'reverse_charge' | 'outside_scope';
    rateBps: number;
  };
  subscription: {
    id: string;
    status: 'active' | 'past_due' | 'suspended' | 'cancelled';
    anchorDate: string;
    planId: string | null;
    currentPeriod: { start: string; end: string };
  } | null;
}

/** An RFC 9457 problem document, which is how every API failure arrives. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    // Billing data changes underneath the page — an invoice is issued, a
    // payment fails — and a cached page would show a merchant a state that has
    // already moved on.
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    // The API answers every failure with a problem document, but a proxy or a
    // crash can still return something else, so the fallback is not decorative.
    const problem = (await response.json().catch(() => undefined)) as
      | Problem
      | undefined;

    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: response.statusText,
        status: response.status,
      },
    );
  }

  return response.json() as Promise<T>;
}

export function getMerchant(merchantId: string): Promise<MerchantDetail> {
  return get<MerchantDetail>(`/v1/merchants/${merchantId}`);
}

export function getInvoice(invoiceId: string): Promise<Invoice> {
  return get<Invoice>(`/v1/invoices/${invoiceId}`);
}

export function listInvoices(
  merchantId: string,
): Promise<{ invoices: InvoiceSummary[] }> {
  return get<{ invoices: InvoiceSummary[] }>(
    `/v1/merchants/${merchantId}/invoices`,
  );
}
