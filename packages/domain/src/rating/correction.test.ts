import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { money } from '../money/money.js';
import { prepareCorrection } from './correction.js';
import { flatten } from './derivation.js';
import type { InvoiceDraft } from './invoice-draft.js';

const date = (iso: string) => Temporal.PlainDate.from(iso);
const eur = (amount: number) => money(amount, 'EUR');

const SEPTEMBER = { start: date('2026-09-01'), end: date('2026-10-01') };

/** What the invoice said when it was issued: the ADR-0006 worked example. */
const issued = { subtotal: eur(11_824), vat: eur(2247), total: eur(14_071) };

/** What the same period comes to once the upgrade is moved back to the 5th. */
function recomputed(subtotal: number, vat: number, total: number): InvoiceDraft {
  return {
    period: SEPTEMBER,
    currency: 'EUR',
    lines: [
      {
        kind: 'subscription',
        description: 'Subscription — payments_plus',
        amount: eur(1647),
        vatRateBps: 1900,
        derivation: { result: eur(1647), formula: 'monthly fee × days ÷ days', inputs: [] },
      },
    ],
    subtotal: eur(subtotal),
    vat: eur(vat),
    total: eur(total),
    vatTreatment: 'standard',
  };
}

describe('prepareCorrection', () => {
  it('credits the difference when the period turns out to have cost less', () => {
    // 14071 was charged, 11385 was owed. The merchant is 2686 up.
    const correction = prepareCorrection({
      period: SEPTEMBER,
      issued,
      recomputed: recomputed(9567, 1818, 11_385),
    });

    expect(correction.kind).toBe('credit');
    if (correction.kind !== 'credit') {
      throw new Error('expected a credit');
    }

    // Stored as negatives, so a document list sums to what is owed and the
    // ledger call is the same one the invoice used.
    expect(correction.draft.subtotal).toEqual(eur(-2257));
    expect(correction.draft.vat).toEqual(eur(-429));
    expect(correction.draft.total).toEqual(eur(-2686));
    expect(correction.draft.total).toEqual(
      money(correction.draft.subtotal.amount + correction.draft.vat.amount, 'EUR'),
    );
  });

  it('explains the credit with both totals, not just the difference', () => {
    // "Why 2686" has to be answerable without re-deriving anything: the
    // explanation carries what was charged and what should have been.
    const correction = prepareCorrection({
      period: SEPTEMBER,
      issued,
      recomputed: recomputed(9567, 1818, 11_385),
    });
    if (correction.kind !== 'credit') {
      throw new Error('expected a credit');
    }

    const line = correction.draft.lines[0];
    if (!line) {
      throw new Error('a credit note without a line explains nothing');
    }
    expect(line.kind).toBe('proration_credit');

    // flatten returns the nodes; the amounts live on the value ones.
    const amounts = flatten(line.derivation)
      .filter((node) => node.kind === 'value')
      .map((node) => (typeof node.value === 'object' ? node.value.amount : node.value));

    expect(amounts).toContain(14_071);
    expect(amounts).toContain(11_385);
  });

  it('does nothing when the recomputed period comes to the same amount', () => {
    expect(
      prepareCorrection({ period: SEPTEMBER, issued, recomputed: recomputed(11_824, 2247, 14_071) }),
    ).toEqual({ kind: 'none' });
  });

  it('refuses to credit when the period turns out to have cost more', () => {
    // A backdated change can raise the price too, and that is a supplementary
    // invoice with its own number, not a credit note with a minus sign.
    const correction = prepareCorrection({
      period: SEPTEMBER,
      issued,
      recomputed: recomputed(13_000, 2470, 15_470),
    });

    expect(correction).toEqual({ kind: 'undercharge', shortfall: eur(1399) });
  });

  it('carries the VAT treatment of the period it corrects', () => {
    const reverseCharged: InvoiceDraft = {
      ...recomputed(9567, 0, 9567),
      vatTreatment: 'reverse_charge',
    };

    const correction = prepareCorrection({
      period: SEPTEMBER,
      issued: { subtotal: eur(11_824), vat: eur(0), total: eur(11_824) },
      recomputed: reverseCharged,
    });
    if (correction.kind !== 'credit') {
      throw new Error('expected a credit');
    }

    expect(correction.draft.vatTreatment).toBe('reverse_charge');
    expect(correction.draft.vat).toEqual(eur(0));
  });

  it('refuses to compare periods in different currencies', () => {
    expect(() =>
      prepareCorrection({
        period: SEPTEMBER,
        issued,
        recomputed: { ...recomputed(9567, 1818, 11_385), currency: 'GBP' },
      }),
    ).toThrow();
  });
});
