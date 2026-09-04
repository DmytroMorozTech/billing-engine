import { Body, Compact } from '@sumup-oss/circuit-ui';

import type { Derivation, DerivationNode, Money } from '../../lib/api.js';
import { formatMoney } from '../../lib/money.js';

import classes from './DerivationTree.module.css';

export interface DerivationTreeProps {
  derivation: Derivation;
  /** Nesting depth. Only the top level states its own result. */
  depth?: number;
}

function isMoney(value: Money | number | string): value is Money {
  return typeof value === 'object' && value !== null && 'currency' in value;
}

function formatValue(value: Money | number | string): string {
  return isMoney(value) ? formatMoney(value) : String(value);
}

/**
 * Renders a recorded derivation as a tree.
 *
 * Built out of `<details>` and `<summary>` rather than state, so it collapses
 * without shipping a single byte of JavaScript and stays a Server Component.
 * The browser gives the keyboard and screen-reader behaviour for free, which a
 * hand-rolled disclosure would have to reimplement and usually gets wrong.
 *
 * Recursive on purpose: a MOTO commission line nests its percentage component
 * inside the total, and a tree that rendered one level would silently drop the
 * half that explains the number.
 */
export function DerivationTree({ derivation, depth = 0 }: DerivationTreeProps) {
  const { formula, rounding, inputs } = derivation;

  return (
    <div className={classes.tree}>
      <Body size="s" className={classes.formula}>
        {formula}
      </Body>

      <dl className={classes.inputs}>
        {inputs.map((node, index) => (
          /* A derivation is an immutable record of a calculation that already
             happened: its inputs are never reordered, inserted into or removed,
             so the position is a stable identity rather than an accident. */
          <DerivationInput
            // biome-ignore lint/suspicious/noArrayIndexKey: inputs are a fixed, immutable, ordered record
            key={`${node.kind}-${node.label}-${index}`}
            node={node}
            depth={depth}
          />
        ))}
      </dl>

      {rounding && (
        <Compact size="s" color="subtle" className={classes.rounding}>
          {`Exact ${rounding.exact}, rounded to ${formatMoney(derivation.result)} (${rounding.mode})`}
        </Compact>
      )}
    </div>
  );
}

function DerivationInput({
  node,
  depth,
}: {
  node: DerivationNode;
  depth: number;
}) {
  if (node.kind === 'computation') {
    return (
      <div className={classes.nested}>
        <details>
          <summary>
            <Compact size="s" as="span">
              {node.label}
            </Compact>
            <Compact size="s" as="span" color="subtle">
              {formatMoney(node.derivation.result)}
            </Compact>
          </summary>
          <DerivationTree derivation={node.derivation} depth={depth + 1} />
        </details>
      </div>
    );
  }

  if (node.kind === 'event') {
    return (
      <>
        <dt>
          <Compact size="s">{node.label}</Compact>
        </dt>
        <dd>
          {/* Both times, always. When it happened and when we learned of it are
              different facts, and a timeline that shows only one cannot explain
              a correction. */}
          <Compact size="s" color="subtle">
            {`occurred ${node.occurredAt}, recorded ${node.recordedAt}`}
          </Compact>
        </dd>
      </>
    );
  }

  return (
    <>
      <dt>
        <Compact size="s">{node.label}</Compact>
      </dt>
      <dd>
        <Compact size="s">{formatValue(node.value)}</Compact>
      </dd>
    </>
  );
}
