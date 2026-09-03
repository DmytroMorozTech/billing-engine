import { describe, expect, it } from 'vitest';

import { isVatIdFormatValid, vatTreatment } from './vat.js';

const DE = { marketId: 'DE', rateBps: 1900, reverseChargeAvailable: true };
const IT = { marketId: 'IT', rateBps: 2200, reverseChargeAvailable: true };
const GB = { marketId: 'GB', rateBps: 2000, reverseChargeAvailable: false };

/** Everything is invoiced by the German entity, the only one that exists. */
const from = (customer: typeof DE, customerVatId: string | null) =>
  vatTreatment({ supplierMarketId: 'DE', customer, customerVatId });

describe('isVatIdFormatValid', () => {
  it('accepts the national formats', () => {
    expect(isVatIdFormatValid('DE123456789', 'DE')).toBe(true);
    expect(isVatIdFormatValid('IT12345678901', 'IT')).toBe(true);
    expect(isVatIdFormatValid('GB123456789', 'GB')).toBe(true);
    expect(isVatIdFormatValid('GB123456789012', 'GB')).toBe(true);
  });

  it('rejects the right number of digits in the wrong country', () => {
    // A German number is nine digits, an Italian one eleven. Accepting either
    // for either market is how a reverse charge gets applied to an invoice that
    // should have carried 22%.
    expect(isVatIdFormatValid('DE12345678901', 'DE')).toBe(false);
    expect(isVatIdFormatValid('IT123456789', 'IT')).toBe(false);
  });

  it('rejects a number whose country does not match the market', () => {
    expect(isVatIdFormatValid('DE123456789', 'IT')).toBe(false);
  });

  it('tolerates the way people actually type them', () => {
    expect(isVatIdFormatValid('de 123 456 789', 'DE')).toBe(true);
  });

  it('rejects nothing at all', () => {
    expect(isVatIdFormatValid(null, 'DE')).toBe(false);
    expect(isVatIdFormatValid('   ', 'DE')).toBe(false);
  });
});

describe('vatTreatment', () => {
  it('charges the domestic rate at home, VAT ID or not', () => {
    // A German entity invoicing a German merchant charges German VAT. The
    // merchant having a VAT ID does not move the supply anywhere.
    expect(from(DE, 'DE123456789')).toEqual({ kind: 'standard', rateBps: 1900 });
    expect(from(DE, null)).toEqual({ kind: 'standard', rateBps: 1900 });
  });

  it('shifts the liability to an EU business with a VAT ID', () => {
    expect(from(IT, 'IT12345678901')).toEqual({ kind: 'reverse_charge', rateBps: 0 });
  });

  it('treats an EU customer without a VAT ID as a consumer, at their own rate', () => {
    expect(from(IT, null)).toEqual({ kind: 'standard', rateBps: 2200 });
  });

  it('will not shift the liability on a malformed VAT ID', () => {
    // The dangerous case. Trusting an unchecked string here issues an invoice
    // with no VAT on it, and the liability stays with us.
    expect(from(IT, 'IT999')).toEqual({ kind: 'standard', rateBps: 2200 });
  });

  it('puts a non-EU business outside the scope rather than under reverse charge', () => {
    // Both come to zero, and they are not the same thing: reverse charge cites
    // an EU directive the United Kingdom left.
    expect(from(GB, 'GB123456789')).toEqual({ kind: 'outside_scope', rateBps: 0 });
  });

  it('charges a non-EU consumer the local rate', () => {
    expect(from(GB, null)).toEqual({ kind: 'standard', rateBps: 2000 });
  });
});
