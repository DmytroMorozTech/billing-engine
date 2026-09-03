import type { CurrencyCode, Money, RateInterval, RateTerms } from '@billing/domain';
import { money } from '@billing/domain';
import type { Insertable } from 'kysely';
import { Temporal } from 'temporal-polyfill';

import type { RateIntervalsTable } from './schema.js';

/**
 * Translation between database rows and domain values.
 *
 * Kept in one file on purpose. Every place that turns a `BIGINT` into `Money`
 * or a `DATE` string into a `Temporal.PlainDate` is a place where a currency
 * could be lost or a date reinterpreted in the wrong zone, and those are
 * exactly the mistakes this project exists to avoid making quietly.
 */

/** The subset of a plan or interval row that carries pricing terms. */
export interface TermsRow {
  monthly_fee_minor: number;
  currency: string;
  in_person_rate_bps: number;
  online_rate_bps: number;
  moto_rate_bps: number;
  moto_fixed_fee_minor: number;
}

export interface RateIntervalRow extends TermsRow {
  id: string;
  plan_id: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Derived from the Kysely table type rather than hand-written, so that adding a
 * column to the schema is a type error here rather than a runtime surprise.
 */
export type RateIntervalValues = Insertable<RateIntervalsTable>;

export function toMoney(amount: number, currency: string): Money {
  return money(amount, currency as CurrencyCode);
}

export function toPlainDate(iso: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(iso);
}

export function fromPlainDate(date: Temporal.PlainDate): string {
  return date.toString();
}

export function toOptionalPlainDate(iso: string | null): Temporal.PlainDate | null {
  return iso === null ? null : Temporal.PlainDate.from(iso);
}

export function fromOptionalPlainDate(date: Temporal.PlainDate | null): string | null {
  return date === null ? null : date.toString();
}

export function termsFromRow(planId: string, row: TermsRow): RateTerms {
  return {
    planId,
    monthlyFee: toMoney(row.monthly_fee_minor, row.currency),
    rates: {
      in_person: row.in_person_rate_bps,
      online: row.online_rate_bps,
      moto: row.moto_rate_bps,
    },
    motoFixedFee: toMoney(row.moto_fixed_fee_minor, row.currency),
  };
}

export function toRateInterval(row: RateIntervalRow): RateInterval {
  return {
    id: row.id,
    ...termsFromRow(row.plan_id, row),
    effectiveFrom: toPlainDate(row.effective_from),
    effectiveTo: toOptionalPlainDate(row.effective_to),
  };
}

export function rateIntervalValues(
  interval: RateInterval,
  subscriptionId: string,
): RateIntervalValues {
  return {
    id: interval.id,
    subscription_id: subscriptionId,
    plan_id: interval.planId,
    monthly_fee_minor: interval.monthlyFee.amount,
    currency: interval.monthlyFee.currency,
    in_person_rate_bps: interval.rates.in_person,
    online_rate_bps: interval.rates.online,
    moto_rate_bps: interval.rates.moto,
    moto_fixed_fee_minor: interval.motoFixedFee.amount,
    effective_from: fromPlainDate(interval.effectiveFrom),
    effective_to: fromOptionalPlainDate(interval.effectiveTo),
  };
}
