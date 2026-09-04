import type { Money } from './api.js';

/**
 * Formats an amount that arrives as an integer in the currency's minor unit.
 *
 * The API never sends a decimal and this never produces one for arithmetic —
 * the string is for a human to read (ADR-0001). `Intl` is given the already
 * divided value only at the point of display, and the division uses the
 * currency's own exponent rather than a hardcoded 100, because JPY has none.
 */
export function formatMoney(money: Money, locale = 'en-GB'): string {
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
  });

  const exponent = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(money.amount / 10 ** exponent);
}

/** A plain ISO date, formatted for reading. Never parsed back. */
export function formatDate(isoDate: string, locale = 'en-GB'): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) {
    return isoDate;
  }

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    // The date is already local to the merchant's billing zone; rendering it in
    // the reader's zone would move it by a day for half the world.
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * A commission rate, which arrives in basis points.
 *
 * 169 bps is 1.69%. Integers all the way here too — the division is for the
 * reader and happens nowhere else.
 */
export function formatRate(basisPoints: number, locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
}

/**
 * Today's date in a given IANA time zone, as an ISO date string.
 *
 * Whose "today" it is matters here. Which plan is in force, and which billing
 * period a date falls in, are questions about the merchant's calendar — and
 * either side of midnight in Berlin the answer differs from the server's. The
 * backend takes the same care (ADR-0002); this is the display end of it.
 */
export function todayIn(timeZone: string): string {
  // `en-CA` because it formats as YYYY-MM-DD, which is what the API speaks and
  // what compares correctly as a string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
