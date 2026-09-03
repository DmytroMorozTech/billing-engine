import { money, sum } from '@billing/domain';
import { describe, expect, it } from 'vitest';

import { invoicePostings, merchantWalletKey } from './ledger.js';

const MERCHANT = '00000000-0000-7000-8000-0000000000c1';
const eur = (amount: number) => money(amount, 'EUR');

/**
 * Which lines an invoice becomes in the ledger.
 *
 * Pure, so it is tested without a database. The database still refuses a zero
 * posting (ZeroPostingError, and a CHECK behind it); this is the one place
 * allowed to decide that a line should not exist at all.
 */
describe('invoicePostings', () => {
  it('splits an invoice into wallet, revenue and VAT', () => {
    const postings = invoicePostings({
      merchantId: MERCHANT,
      subtotal: eur(11_824),
      vat: eur(2247),
      total: eur(14_071),
    });

    expect(postings).toEqual([
      { accountKey: merchantWalletKey(MERCHANT), amount: eur(-14_071) },
      { accountKey: 'platform:revenue', amount: eur(11_824) },
      { accountKey: 'platform:vat_payable', amount: eur(2247) },
    ]);
    expect(sum(postings.map((p) => p.amount), 'EUR').amount).toBe(0);
  });

  it('omits the VAT line when there is no VAT to owe', () => {
    // Reverse charge for a B2B merchant with a valid VAT ID: the tax is the
    // customer's to account for, so no VAT liability arises here. The line is
    // not written as zero — it does not exist.
    const postings = invoicePostings({
      merchantId: MERCHANT,
      subtotal: eur(11_824),
      vat: eur(0),
      total: eur(11_824),
    });

    expect(postings).toEqual([
      { accountKey: merchantWalletKey(MERCHANT), amount: eur(-11_824) },
      { accountKey: 'platform:revenue', amount: eur(11_824) },
    ]);
    expect(sum(postings.map((p) => p.amount), 'EUR').amount).toBe(0);
  });

  it('posts nothing at all for an invoice of zero', () => {
    // A merchant on the free plan with no volume owes nothing. No money moved,
    // so there is no transfer to record.
    expect(
      invoicePostings({
        merchantId: MERCHANT,
        subtotal: eur(0),
        vat: eur(0),
        total: eur(0),
      }),
    ).toEqual([]);
  });

  it('reverses every line for a credit note', () => {
    const postings = invoicePostings({
      merchantId: MERCHANT,
      subtotal: eur(-11_824),
      vat: eur(-2247),
      total: eur(-14_071),
    });

    expect(postings).toEqual([
      { accountKey: merchantWalletKey(MERCHANT), amount: eur(14_071) },
      { accountKey: 'platform:revenue', amount: eur(-11_824) },
      { accountKey: 'platform:vat_payable', amount: eur(-2247) },
    ]);
    expect(sum(postings.map((p) => p.amount), 'EUR').amount).toBe(0);
  });
});
