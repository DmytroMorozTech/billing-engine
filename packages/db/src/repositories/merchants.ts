import type { CurrencyCode, VatTreatment } from '@billing/domain';
import { vatTreatment } from '@billing/domain';
import type { Temporal } from 'temporal-polyfill';

import { fromPlainDate, toPlainDate } from '../mappers.js';
import type { Db } from './subscriptions.js';

export interface NewMerchantInput {
  id: string;
  legalEntityId: string;
  marketId: string;
  currency: CurrencyCode;
  email: string;
  name: string;
  /** IANA identifier. Validated here, because the schema cannot. */
  billingTimeZone: string;
  vatId?: string | null;
}

export interface MerchantContext {
  id: string;
  legalEntityId: string;
  /** The market of the entity issuing the invoice, not of the merchant. */
  legalEntityMarketId: string;
  marketId: string;
  currency: CurrencyCode;
  billingTimeZone: string;
  vatId: string | null;
  /** The VAT rate of the merchant's market, in basis points. */
  vatRateBps: number;
  /** False outside the EU, where the reverse-charge mechanism does not reach. */
  reverseChargeAvailable: boolean;
}

/**
 * The VAT treatment of an invoice to this merchant.
 *
 * A thin adapter, on purpose: the rule itself is pure and lives in the domain,
 * where it is tested without a database. This is the one place that knows which
 * database column feeds which part of it, so a caller cannot pair the merchant's
 * market with the supplier's rate by accident.
 */
export function vatTreatmentFor(merchant: MerchantContext): VatTreatment {
  return vatTreatment({
    supplierMarketId: merchant.legalEntityMarketId,
    customer: {
      marketId: merchant.marketId,
      rateBps: merchant.vatRateBps,
      reverseChargeAvailable: merchant.reverseChargeAvailable,
    },
    customerVatId: merchant.vatId,
  });
}

export interface NewSubscriptionInput {
  id: string;
  merchantId: string;
  anchorDate: Temporal.PlainDate;
  startedOn?: Temporal.PlainDate;
}

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`"${timeZone}" is not a known IANA time zone`);
    this.name = 'InvalidTimeZoneError';
  }
}

/**
 * A CHECK constraint cannot validate this — it would need a subquery against
 * `pg_timezone_names` — so the boundary does it instead (ADR-0009). An
 * unrecognised zone must never reach a row, because every period boundary and
 * every transaction date is computed in it.
 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    // Intl rather than Temporal.Now: this is validation, and it has no business
    // reading the current time to do it.
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
}

export async function createMerchant(db: Db, input: NewMerchantInput): Promise<void> {
  assertValidTimeZone(input.billingTimeZone);

  await db
    .insertInto('merchants')
    .values({
      id: input.id,
      legal_entity_id: input.legalEntityId,
      market_id: input.marketId,
      currency: input.currency,
      email: input.email,
      name: input.name,
      billing_time_zone: input.billingTimeZone,
      vat_id: input.vatId ?? null,
    })
    .execute();
}

/**
 * Everything a billing run needs to know about a merchant, in one read.
 *
 * The VAT rate is joined in rather than looked up separately: a run that used
 * one merchant's zone with another market's rate would produce an invoice that
 * is wrong in a way nobody notices until an audit.
 */
export async function merchantContext(db: Db, merchantId: string): Promise<MerchantContext> {
  const row = await db
    .selectFrom('merchants')
    .innerJoin('markets', 'markets.id', 'merchants.market_id')
    .innerJoin('legal_entities', 'legal_entities.id', 'merchants.legal_entity_id')
    .select([
      'merchants.id as id',
      'merchants.legal_entity_id as legal_entity_id',
      'merchants.market_id as market_id',
      'merchants.currency as currency',
      'merchants.billing_time_zone as billing_time_zone',
      'merchants.vat_id as vat_id',
      'markets.vat_rate_bps as vat_rate_bps',
      'markets.reverse_charge_available as reverse_charge_available',
      'legal_entities.market_id as legal_entity_market_id',
    ])
    .where('merchants.id', '=', merchantId)
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    legalEntityMarketId: row.legal_entity_market_id,
    marketId: row.market_id,
    currency: row.currency as CurrencyCode,
    billingTimeZone: row.billing_time_zone,
    vatId: row.vat_id,
    vatRateBps: row.vat_rate_bps,
    reverseChargeAvailable: row.reverse_charge_available,
  };
}

export async function createSubscription(db: Db, input: NewSubscriptionInput): Promise<void> {
  await db
    .insertInto('subscriptions')
    .values({
      id: input.id,
      merchant_id: input.merchantId,
      anchor_date: fromPlainDate(input.anchorDate),
      status: 'active',
      started_on: fromPlainDate(input.startedOn ?? input.anchorDate),
      cancelled_on: null,
    })
    .execute();
}

export interface SubscriptionContext {
  id: string;
  merchantId: string;
  anchorDate: Temporal.PlainDate;
  status: 'active' | 'past_due' | 'suspended' | 'cancelled';
}

/** The one live subscription of a merchant, if there is one. */
export async function liveSubscription(
  db: Db,
  merchantId: string,
): Promise<SubscriptionContext | undefined> {
  const row = await db
    .selectFrom('subscriptions')
    .select(['id', 'merchant_id', 'anchor_date', 'status'])
    .where('merchant_id', '=', merchantId)
    .where('status', '!=', 'cancelled')
    .executeTakeFirst();

  return row === undefined
    ? undefined
    : {
        id: row.id,
        merchantId: row.merchant_id,
        anchorDate: toPlainDate(row.anchor_date),
        status: row.status,
      };
}
