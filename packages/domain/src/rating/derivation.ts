import type { Money } from '../money/money.js';
import { ROUNDING_MODE, type RoundingMode } from '../money/rounding.js';

/**
 * How an amount came to be.
 *
 * Built while the amount is computed and stored alongside it. Never recomputed
 * on read: a later change to the calculation must not be able to make the
 * explanation disagree with the invoice it explains. That is the whole reason
 * this type exists rather than a `describe(line)` function.
 */
export interface Derivation {
  result: Money;
  /** Human-readable, e.g. `volume × rate`. Not evaluated, only shown. */
  formula: string;
  rounding?: {
    mode: RoundingMode;
    /** The value before rounding, e.g. `"6979.70"`. */
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
      /** When we learned of it. The gap is what the support timeline shows. */
      recordedAt: string;
    }
  | { kind: 'computation'; label: string; derivation: Derivation };

export function value(label: string, v: Money | number | string): DerivationNode {
  return { kind: 'value', label, value: v };
}

export function event(
  label: string,
  eventId: string,
  occurredAt: string,
  recordedAt: string,
): DerivationNode {
  return { kind: 'event', label, eventId, occurredAt, recordedAt };
}

export function computation(label: string, derivation: Derivation): DerivationNode {
  return { kind: 'computation', label, derivation };
}

export function rounded(exact: string, applied: number): NonNullable<Derivation['rounding']> {
  return { mode: ROUNDING_MODE, exact, applied };
}

/**
 * Walks a derivation tree and returns every leaf value.
 *
 * Used by tests to assert that an explanation actually mentions the inputs it
 * claims to be built from — an explanation that omits its own inputs is worse
 * than none, because it looks authoritative.
 */
export function flatten(derivation: Derivation): DerivationNode[] {
  return derivation.inputs.flatMap((node) =>
    node.kind === 'computation' ? [node, ...flatten(node.derivation)] : [node],
  );
}
