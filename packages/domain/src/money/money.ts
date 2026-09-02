import { type CurrencyCode, minorUnitsPerMajor } from './currency.js';
import { divideRound, quotientToDecimalString } from './rounding.js';

/**
 * An amount of money as an integer in the currency's minor unit.
 *
 * `{ amount: 1999, currency: 'EUR' }` is €19.99. Floating point never
 * represents money anywhere in this system — see ADR-0001. The shape is a plain
 * object so it serialises to JSON as-is, with no custom encoder to forget.
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/**
 * A rate expressed in basis points: 169 is 1.69%, 1900 is 19%.
 *
 * Integers, so that applying a rate stays in integer arithmetic and only the
 * final division rounds.
 */
export type BasisPoints = number;

export const BASIS_POINTS_DENOMINATOR = 10_000n;

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`Cannot combine ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidAmountError extends Error {
  constructor(amount: number) {
    super(`Money amount must be a safe integer, received ${amount}`);
    this.name = 'InvalidAmountError';
  }
}

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new InvalidAmountError(amount);
  }
  // `-0` is a safe integer and `-0 === 0`, but the two are not the same value
  // to `Object.is`, so they compare unequal via deep equality and serialise
  // differently. A ledger row of "-0.00" is nonsense; normalise it away here,
  // at the single point where every Money is constructed.
  return { amount: amount === 0 ? 0 : amount, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amount: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

function fromBigInt(amount: bigint, currency: CurrencyCode): Money {
  return money(Number(amount), currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function absolute(a: Money): Money {
  return money(Math.abs(a.amount), a.currency);
}

/** Sums a list. The currency is explicit so that an empty list still has one. */
export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce<Money>((total, item) => add(total, item), zero(currency));
}

/** Exact multiplication by a whole number. No rounding can occur. */
export function multiply(a: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new InvalidAmountError(factor);
  }
  return fromBigInt(BigInt(a.amount) * BigInt(factor), a.currency);
}

/**
 * Applies a rate given in basis points. Rounds once, at the end.
 *
 * `applyRate(money(413_000, 'EUR'), 169)` → 6980, because 413000 × 169 ÷ 10000
 * is 6979.70 and the rounding mode is half away from zero.
 */
export function applyRate(a: Money, rate: BasisPoints): Money {
  if (!Number.isSafeInteger(rate)) {
    throw new InvalidAmountError(rate);
  }
  const numerator = BigInt(a.amount) * BigInt(rate);
  return fromBigInt(divideRound(numerator, BASIS_POINTS_DENOMINATOR), a.currency);
}

/** The un-rounded result of {@link applyRate}, for recording in a derivation. */
export function applyRateExact(a: Money, rate: BasisPoints, decimals = 2): string {
  const numerator = BigInt(a.amount) * BigInt(rate);
  return quotientToDecimalString(numerator, BASIS_POINTS_DENOMINATOR, decimals);
}

/**
 * Takes `numerator/denominator` of an amount — a proration.
 *
 * `prorate(money(1900, 'EUR'), 16, 30)` → 1013, sixteen days of a €19 month.
 */
export function prorate(a: Money, numerator: number, denominator: number): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new InvalidAmountError(Number.isSafeInteger(numerator) ? denominator : numerator);
  }
  if (denominator === 0) {
    throw new RangeError('Cannot prorate over a zero-length period');
  }
  const product = BigInt(a.amount) * BigInt(numerator);
  return fromBigInt(divideRound(product, BigInt(denominator)), a.currency);
}

/** The un-rounded result of {@link prorate}, for recording in a derivation. */
export function prorateExact(
  a: Money,
  numerator: number,
  denominator: number,
  decimals = 2,
): string {
  const product = BigInt(a.amount) * BigInt(numerator);
  return quotientToDecimalString(product, BigInt(denominator), decimals);
}

/**
 * Splits an amount across weights so that the parts sum back to the original
 * exactly — no cent is created or lost.
 *
 * Uses the largest-remainder method: every part gets its truncated share, then
 * the leftover units go one each to the parts with the largest remainders.
 * Ties are broken by position so the result is deterministic, which matters
 * because a closed period must recompute byte-identically.
 */
export function allocate(a: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new RangeError('allocate requires at least one weight');
  }
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('allocate weights must be non-negative integers');
  }

  const total = weights.reduce((acc, w) => acc + w, 0);
  if (total === 0) {
    throw new RangeError('allocate weights must not sum to zero');
  }

  const sign = a.amount < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(a.amount));
  const totalWeight = BigInt(total);

  const shares = weights.map((w) => (magnitude * BigInt(w)) / totalWeight);
  const remainders = weights.map((w, index) => ({
    index,
    remainder: (magnitude * BigInt(w)) % totalWeight,
  }));

  remainders.sort((left, right) =>
    left.remainder === right.remainder
      ? left.index - right.index
      : right.remainder > left.remainder
        ? 1
        : -1,
  );

  let leftover = magnitude - shares.reduce((acc, share) => acc + share, 0n);
  for (let i = 0; leftover > 0n; i += 1, leftover -= 1n) {
    // `remainders` is non-empty because `weights` is, so the index is safe.
    const target = remainders[i % remainders.length]!.index;
    shares[target] = shares[target]! + 1n;
  }

  return shares.map((share) => fromBigInt(sign * share, a.currency));
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}

export function isNegative(a: Money): boolean {
  return a.amount < 0;
}

export function isPositive(a: Money): boolean {
  return a.amount > 0;
}

/**
 * Renders the amount as a plain decimal string: `6980` EUR → `"69.80"`.
 *
 * For logs, tests and derivations. User-facing formatting is locale-aware and
 * happens once in the UI layer, not here.
 */
export function toDecimalString(a: Money): string {
  const perMajor = minorUnitsPerMajor(a.currency);
  if (perMajor === 1n) {
    return a.amount.toString();
  }
  return quotientToDecimalString(BigInt(a.amount), perMajor, exponentOf(perMajor));
}

function exponentOf(perMajor: bigint): number {
  return perMajor.toString().length - 1;
}
