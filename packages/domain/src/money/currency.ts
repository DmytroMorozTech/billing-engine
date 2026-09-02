/**
 * Currencies the platform can price in.
 *
 * The value is the ISO-4217 minor unit exponent, i.e. how many decimal places
 * the currency has. It is deliberately not hardcoded as `100` anywhere: JPY has
 * no minor unit at all, and that difference has to survive the first non-EUR
 * market being added.
 */
export const CURRENCIES = {
  EUR: 2,
  GBP: 2,
  USD: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && value in CURRENCIES;
}

/** Number of decimal places for the currency. `EUR` → 2, `JPY` → 0. */
export function minorUnitExponent(currency: CurrencyCode): number {
  return CURRENCIES[currency];
}

/** How many minor units make one major unit. `EUR` → 100, `JPY` → 1. */
export function minorUnitsPerMajor(currency: CurrencyCode): bigint {
  return 10n ** BigInt(CURRENCIES[currency]);
}
