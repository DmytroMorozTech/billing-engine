/**
 * Integer division with rounding, done in `bigint`.
 *
 * `bigint` rather than `number` because the intermediate products are large:
 * an amount of 10^12 minor units multiplied by 10^4 basis points overflows
 * `Number.MAX_SAFE_INTEGER`. The inputs and outputs of the money API are safe
 * integers; only the arithmetic in the middle needs the wider type.
 */

/**
 * The project rounds one way and only one way. See ADR-0001.
 *
 * Half away from zero (commercial rounding): 2.5 → 3, -2.5 → -3. This is what
 * EU VAT guidance assumes, and it is symmetric, which matters when a credit
 * note has to exactly reverse a charge.
 */
export const ROUNDING_MODE = 'half-away-from-zero' as const;

export type RoundingMode = typeof ROUNDING_MODE;

export function divideRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  // `remainder * 2 >= d` is `remainder / d >= 0.5` without leaving integers.
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Renders `numerator / denominator` as a fixed-point decimal string.
 *
 * Used only to record the pre-rounding value in a derivation, so that a support
 * screen can show "6979.70 → 6980" rather than an unexplained integer. It is
 * never fed back into arithmetic.
 */
export function quotientToDecimalString(
  numerator: bigint,
  denominator: bigint,
  decimals = 2,
): string {
  if (decimals < 0) {
    throw new RangeError('decimals must be non-negative');
  }

  const scale = 10n ** BigInt(decimals);
  const scaled = divideRound(numerator * scale, denominator);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, '0');

  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';

  return `${negative ? '-' : ''}${whole}${fraction}`;
}
