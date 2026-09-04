import type { Invoice } from '../../lib/api.js';
import { axe, render, screen } from '../../test-utils.js';

import { InvoiceDetail } from './InvoiceDetail.js';

/** DE-2026-000001, trimmed to one line. The shape is the API's. */
const invoice: Invoice = {
  id: '00000000-0000-7000-8000-000000000007',
  number: 'DE-2026-000001',
  status: 'paid',
  periodStart: '2026-09-01',
  periodEnd: '2026-10-01',
  issuedOn: '2026-10-01',
  dueOn: '2026-10-15',
  vatTreatment: 'standard',
  subtotal: { amount: 11824, currency: 'EUR' },
  vat: { amount: 2247, currency: 'EUR' },
  total: { amount: 14071, currency: 'EUR' },
  netTotal: { amount: 14071, currency: 'EUR' },
  lines: [
    {
      position: 0,
      kind: 'subscription',
      description: 'Subscription — payments_plus, 2026-09-15 to 2026-10-01',
      amount: { amount: 1013, currency: 'EUR' },
      vatRateBps: 1900,
      derivation: {
        result: { amount: 1013, currency: 'EUR' },
        formula: 'monthly fee × days in segment ÷ days in period',
        rounding: {
          mode: 'half-away-from-zero',
          exact: '1013.33',
          applied: 1013,
        },
        inputs: [{ kind: 'value', label: 'Days in segment', value: 16 }],
      },
    },
  ],
  paymentAttempts: [],
  creditNotes: [],
};

describe('InvoiceDetail', () => {
  it('should meet accessibility guidelines', async () => {
    const { container } = render(<InvoiceDetail invoice={invoice} />);
    const actual = await axe(container);
    expect(actual).toHaveNoViolations();
  });

  it('identifies the invoice and the period it covers', () => {
    render(<InvoiceDetail invoice={invoice} />);

    expect(screen.getByText('DE-2026-000001')).toBeInTheDocument();

    // Matched as one string: "1 Oct 2026" also appears in the issued/due line,
    // so asserting the dates separately would match two elements. `Sept?`
    // because the month abbreviation is the platform's — en-GB shortens
    // September to four letters and every other month to three.
    expect(screen.getByText(/1 Sept? 2026 – 1 Oct 2026/)).toBeInTheDocument();
  });

  it('explains each line rather than only stating its amount', () => {
    render(<InvoiceDetail invoice={invoice} />);

    expect(screen.getByText('€10.13')).toBeInTheDocument();
    expect(
      screen.getByText('monthly fee × days in segment ÷ days in period'),
    ).toBeInTheDocument();
  });

  /**
   * The reason this project stores a treatment rather than a rate: zero VAT
   * arrives for two different reasons and they cite different law. An invoice
   * showing no VAT has to say which one applied.
   */
  it('says why there is no VAT when there is none', () => {
    const reverseCharge: Invoice = {
      ...invoice,
      vatTreatment: 'reverse_charge',
      vat: { amount: 0, currency: 'EUR' },
    };
    render(<InvoiceDetail invoice={reverseCharge} />);

    expect(screen.getByText(/reverse charge/i)).toBeInTheDocument();
  });

  it('distinguishes an out-of-scope supply from a reverse charge', () => {
    const outsideScope: Invoice = {
      ...invoice,
      vatTreatment: 'outside_scope',
      vat: { amount: 0, currency: 'EUR' },
    };
    render(<InvoiceDetail invoice={outsideScope} />);

    expect(screen.getByText(/outside the scope/i)).toBeInTheDocument();
    expect(screen.queryByText(/reverse charge/i)).not.toBeInTheDocument();
  });

  it('shows what is still owed after a credit note, not only what was billed', () => {
    const corrected: Invoice = {
      ...invoice,
      netTotal: { amount: 11385, currency: 'EUR' },
      creditNotes: [
        {
          id: 'cn-1',
          number: 'DE-CN-2026-000001',
          total: { amount: -2686, currency: 'EUR' },
          issuedOn: '2026-10-04',
        },
      ],
    };
    render(<InvoiceDetail invoice={corrected} />);

    expect(screen.getByText('DE-CN-2026-000001')).toBeInTheDocument();
    // Both numbers: the invoice is not rewritten, so what was billed and what
    // is still charged are different facts and both have to be visible.
    expect(screen.getByText('€140.71')).toBeInTheDocument();
    expect(screen.getByText('€113.85')).toBeInTheDocument();
  });

  it('omits the net total when nothing has been credited', () => {
    render(<InvoiceDetail invoice={invoice} />);
    expect(screen.queryByText(/still charged/i)).not.toBeInTheDocument();
  });

  it('shows the dunning history with the reason each attempt failed', () => {
    const dunned: Invoice = {
      ...invoice,
      status: 'uncollectible',
      paymentAttempts: [
        {
          attempt: 1,
          status: 'failed',
          declineCode: 'insufficient_funds',
          pspChargeId: 'ch_1',
          attemptedAt: '2026-10-01T09:00:00.000Z',
        },
        {
          attempt: 2,
          status: 'failed',
          declineCode: 'card_expired',
          pspChargeId: 'ch_2',
          attemptedAt: '2026-10-02T09:00:00.000Z',
        },
      ],
    };
    render(<InvoiceDetail invoice={dunned} />);

    // "Why is this merchant suspended" is answered here or nowhere.
    expect(screen.getByText('insufficient_funds')).toBeInTheDocument();
    expect(screen.getByText('card_expired')).toBeInTheDocument();
  });

  it('says nothing about payments when none has been attempted', () => {
    render(<InvoiceDetail invoice={invoice} />);
    expect(screen.queryByText(/payment attempts/i)).not.toBeInTheDocument();
  });
});
