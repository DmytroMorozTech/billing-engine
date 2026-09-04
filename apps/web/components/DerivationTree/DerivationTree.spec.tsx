import type { Derivation } from '../../lib/api.js';
import { axe, render, screen } from '../../test-utils.js';

import { DerivationTree } from './DerivationTree.js';

/** The prorated subscription line of DE-2026-000001, as the API returns it. */
const prorated: Derivation = {
  result: { amount: 1013, currency: 'EUR' },
  formula: 'monthly fee × days in segment ÷ days in period',
  rounding: { mode: 'half-away-from-zero', exact: '1013.33', applied: 1013 },
  inputs: [
    {
      kind: 'value',
      label: 'Monthly fee',
      value: { amount: 1900, currency: 'EUR' },
    },
    { kind: 'value', label: 'Days in segment', value: 16 },
    { kind: 'value', label: 'Days in period', value: 30 },
    { kind: 'value', label: 'Period', value: '2026-09-01 to 2026-10-01' },
  ],
};

describe('DerivationTree', () => {
  it('should meet accessibility guidelines', async () => {
    const { container } = render(<DerivationTree derivation={prorated} />);
    const actual = await axe(container);
    expect(actual).toHaveNoViolations();
  });

  it('states the formula the amount came from', () => {
    render(<DerivationTree derivation={prorated} />);
    expect(
      screen.getByText('monthly fee × days in segment ÷ days in period'),
    ).toBeInTheDocument();
  });

  it('labels every input and formats money inputs as money', () => {
    render(<DerivationTree derivation={prorated} />);

    expect(screen.getByText('Monthly fee')).toBeInTheDocument();
    // 1900 minor units, not the integer 1900.
    expect(screen.getByText('€19.00')).toBeInTheDocument();
    expect(screen.getByText('Days in segment')).toBeInTheDocument();
    expect(screen.getByText('16')).toBeInTheDocument();
  });

  it('shows the value before rounding, which is the whole point of recording it', () => {
    render(<DerivationTree derivation={prorated} />);

    // 1013.33 became 1013. A merchant asking "why 10.13 and not 10.14" is
    // asking about exactly this line.
    expect(screen.getByText(/1013\.33/)).toBeInTheDocument();
    expect(screen.getByText(/half-away-from-zero/)).toBeInTheDocument();
  });

  it('omits the rounding note when nothing was rounded', () => {
    const exact: Derivation = { ...prorated, rounding: undefined };
    render(<DerivationTree derivation={exact} />);

    expect(screen.queryByText(/half-away-from-zero/)).not.toBeInTheDocument();
  });

  /**
   * A MOTO commission line nests its percentage component inside the total.
   * The seed has no MOTO volume, so this shape is asserted from a fixture
   * rather than from the demo database — but `buildInvoice` produces it, and a
   * tree that only renders one level would silently drop it.
   */
  it('renders a nested computation rather than dropping it', () => {
    const nested: Derivation = {
      result: { amount: 7205, currency: 'EUR' },
      formula: 'volume × rate + fixed fee × transactions',
      inputs: [
        {
          kind: 'computation',
          label: 'Percentage component',
          derivation: {
            result: { amount: 6980, currency: 'EUR' },
            formula: 'volume × rate',
            inputs: [
              { kind: 'value', label: 'Rate', value: '169 bps = 1.69%' },
            ],
          },
        },
        { kind: 'value', label: 'Transactions', value: 9 },
      ],
    };

    render(<DerivationTree derivation={nested} />);

    expect(screen.getByText('Percentage component')).toBeInTheDocument();
    expect(screen.getByText('volume × rate')).toBeInTheDocument();
    expect(screen.getByText('169 bps = 1.69%')).toBeInTheDocument();
  });

  it('shows both times of a bitemporal event', () => {
    const withEvent: Derivation = {
      ...prorated,
      inputs: [
        {
          kind: 'event',
          label: 'Plan interval opened',
          eventId: 'evt_7f1',
          occurredAt: '2026-09-15T00:00:00+02:00',
          recordedAt: '2026-09-20T09:12:00+02:00',
        },
      ],
    };

    render(<DerivationTree derivation={withEvent} />);

    // When it happened and when we learned of it are different facts, and the
    // difference is what the support console exists to explain.
    expect(screen.getByText(/2026-09-15/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-20/)).toBeInTheDocument();
  });
});
