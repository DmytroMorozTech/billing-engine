import type { CurrencyCode } from '../money/currency.js';
import { type Money, CurrencyMismatchError, subtract } from '../money/money.js';
import type { BillingPeriod } from '../time/billing-cycle.js';
import { computation, value } from './derivation.js';
import type { InvoiceDraft, InvoiceLineDraft } from './invoice-draft.js';

/** The totals an invoice carried when it was issued. */
export interface IssuedTotals {
  subtotal: Money;
  vat: Money;
  total: Money;
}

export interface CorrectionInput {
  period: BillingPeriod;
  issued: IssuedTotals;
  /** The same period, recomputed against the timeline as it now stands. */
  recomputed: InvoiceDraft;
}

export interface CreditNoteDraft {
  period: BillingPeriod;
  currency: CurrencyCode;
  lines: InvoiceLineDraft[];
  /** Negative: a credit note reduces what is owed. */
  subtotal: Money;
  vat: Money;
  total: Money;
  vatTreatment: InvoiceDraft['vatTreatment'];
}

/**
 * What to do about an invoice whose period has been recomputed.
 *
 * `undercharge` is deliberately not a credit note with the sign flipped. Owing
 * more is a supplementary invoice: it needs its own number in the invoice
 * series, it can be dunned, and it is a different document in law. Returning it
 * as a distinct outcome makes the caller decide rather than quietly issue the
 * wrong paperwork.
 */
export type Correction =
  | { kind: 'credit'; draft: CreditNoteDraft }
  | { kind: 'none' }
  | { kind: 'undercharge'; shortfall: Money };

/**
 * Works out the correction owed after a backdated change.
 *
 * Pure, and takes both sides as arguments: what the invoice said, and what the
 * same period comes to now. Neither is recomputed here — the recomputation is
 * the billing calculation itself, and doing it twice in two places is how the
 * two answers start to differ.
 *
 * Amounts are stored negative. A credit note reduces what is owed, so a list of
 * a merchant's documents sums to their balance without special cases, and the
 * ledger posting is the same call the invoice used with the same signs
 * reversed. A rendered document shows them as positives under the word
 * "Gutschrift"; that is presentation, and it belongs to whatever draws the PDF.
 */
export function prepareCorrection(input: CorrectionInput): Correction {
  const { period, issued, recomputed } = input;

  if (issued.total.currency !== recomputed.currency) {
    throw new CurrencyMismatchError(issued.total.currency, recomputed.currency);
  }

  // Negative when the period turned out to cost less than was charged.
  const difference = subtract(recomputed.total, issued.total);

  if (difference.amount === 0) {
    return { kind: 'none' };
  }
  if (difference.amount > 0) {
    return { kind: 'undercharge', shortfall: difference };
  }

  const subtotal = subtract(recomputed.subtotal, issued.subtotal);
  const vat = subtract(recomputed.vat, issued.vat);

  const line: InvoiceLineDraft = {
    kind: 'proration_credit',
    description: `Correction for ${period.start.toString()} to ${period.end.toString()}`,
    amount: subtotal,
    vatRateBps: recomputed.lines[0]?.vatRateBps ?? 0,
    derivation: {
      result: difference,
      formula: 'recomputed total − invoiced total',
      inputs: [
        value('Invoiced', issued.total),
        value('Recomputed', recomputed.total),
        value('Period', `${period.start.toString()} to ${period.end.toString()}`),
        // The recomputed invoice in full, so "why 11385" is answerable from
        // the credit note itself rather than by going to find another document.
        computation('Recomputed invoice', {
          result: recomputed.total,
          formula: 'subtotal + VAT',
          inputs: [
            value('Subtotal', recomputed.subtotal),
            value('VAT', recomputed.vat),
            ...recomputed.lines.map((l) => computation(l.description, l.derivation)),
          ],
        }),
      ],
    },
  };

  return {
    kind: 'credit',
    draft: {
      period,
      currency: recomputed.currency,
      lines: [line],
      subtotal,
      vat,
      total: difference,
      vatTreatment: recomputed.vatTreatment,
    },
  };
}
