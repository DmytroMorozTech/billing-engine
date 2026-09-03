import type { BasisPoints } from '../money/money.js';

/**
 * Which VAT applies, and why.
 *
 * The reason is kept, not just the rate. Two of these come to zero and they are
 * different in law: reverse charge cites an EU directive and shifts the
 * liability to a customer who must account for it, while an out-of-scope supply
 * never entered the EU VAT system at all. An invoice has to say which, and an
 * auditor asking "why is there no VAT on this" needs an answer that is not
 * "because the rate was zero".
 */
export type VatTreatment =
  | { kind: 'standard'; rateBps: BasisPoints }
  | { kind: 'reverse_charge'; rateBps: 0 }
  | { kind: 'outside_scope'; rateBps: 0 };

export interface VatMarket {
  marketId: string;
  rateBps: BasisPoints;
  /** False outside the EU. The United Kingdom is why this exists. */
  reverseChargeAvailable: boolean;
}

export interface VatTreatmentInput {
  /** The market of the entity issuing the invoice. */
  supplierMarketId: string;
  customer: VatMarket;
  customerVatId: string | null;
}

/**
 * National VAT identifier formats.
 *
 * Format only. A well-formed number is not a real one, and the difference
 * matters here: a wrong answer issues an invoice with no VAT and leaves the
 * liability with us. A production system asks VIES and stores the answer with
 * the date it was given, because validity is a fact about a moment. This is the
 * floor beneath that, not a substitute for it.
 */
const VAT_ID_FORMATS: Readonly<Record<string, RegExp>> = {
  DE: /^DE\d{9}$/,
  IT: /^IT\d{11}$/,
  // Nine digits, or twelve for a branch.
  GB: /^GB\d{9}(\d{3})?$/,
};

export function isVatIdFormatValid(vatId: string | null, marketId: string): boolean {
  if (vatId === null) {
    return false;
  }

  // People type them with spaces, and copy them in lower case out of email.
  const normalised = vatId.replace(/\s/g, '').toUpperCase();
  const format = VAT_ID_FORMATS[marketId];

  // The prefix is part of the pattern, so a German number cannot pass as an
  // Italian one just because the digits happen to fit.
  return format === undefined ? false : format.test(normalised);
}

/**
 * Works out the VAT treatment of one invoice.
 *
 * Three rules, in order:
 *
 * 1. **Domestic.** Same market as the supplier: the local rate, whether or not
 *    the customer is a business. Being VAT-registered in your own country does
 *    not move the supply anywhere.
 * 2. **Cross-border business.** A VAT ID that passes its national format means
 *    a business customer, and the liability moves to them — as reverse charge
 *    inside the EU, as an out-of-scope supply outside it.
 * 3. **Cross-border consumer.** No usable VAT ID: charged at the customer's own
 *    rate, which is what the one-stop-shop regime asks for.
 *
 * An unverifiable VAT ID falls to rule 3 rather than rule 2. Erring the other
 * way issues an invoice with no VAT on it and keeps the liability here, which
 * is the expensive direction to be wrong in.
 */
export function vatTreatment(input: VatTreatmentInput): VatTreatment {
  const { supplierMarketId, customer, customerVatId } = input;

  if (customer.marketId === supplierMarketId) {
    return { kind: 'standard', rateBps: customer.rateBps };
  }

  if (isVatIdFormatValid(customerVatId, customer.marketId)) {
    return customer.reverseChargeAvailable
      ? { kind: 'reverse_charge', rateBps: 0 }
      : { kind: 'outside_scope', rateBps: 0 };
  }

  return { kind: 'standard', rateBps: customer.rateBps };
}
