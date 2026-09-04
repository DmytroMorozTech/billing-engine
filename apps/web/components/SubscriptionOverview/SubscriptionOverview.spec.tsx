import type { Subscription } from '../../lib/api.js';
import { axe, render, screen, within } from '../../test-utils.js';

import { SubscriptionOverview } from './SubscriptionOverview.js';

/**
 * Cafe Kreuzberg, the worked example of ADR-0006: on Standard until the 15th,
 * on Payments Plus from then on. Two intervals, not one plan.
 */
const subscription: Subscription = {
  id: '00000000-0000-7000-8000-000000000002',
  anchorDate: '2026-09-01',
  status: 'active',
  currentPeriod: { start: '2026-09-01', end: '2026-10-01' },
  intervals: [
    {
      id: 'i-1',
      planId: 'standard',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-09-15',
      monthlyFee: { amount: 0, currency: 'EUR' },
      rates: { in_person: 169, online: 250, moto: 295 },
    },
    {
      id: 'i-2',
      planId: 'payments_plus',
      effectiveFrom: '2026-09-15',
      effectiveTo: null,
      monthlyFee: { amount: 1900, currency: 'EUR' },
      rates: { in_person: 99, online: 250, moto: 295 },
    },
  ],
};

describe('SubscriptionOverview', () => {
  it('should meet accessibility guidelines', async () => {
    const { container } = render(
      <SubscriptionOverview subscription={subscription} today="2026-09-20" />,
    );
    const actual = await axe(container);
    expect(actual).toHaveNoViolations();
  });

  it('names the plan in force today, not merely the latest one', () => {
    render(
      <SubscriptionOverview subscription={subscription} today="2026-09-10" />,
    );

    // On the 10th the merchant is still on Standard, even though a change to
    // Payments Plus is already on the timeline. Showing the newest interval
    // would be a lie they could check against their own invoice.
    //
    // Scoped to the section: both plan names also appear in the rate table
    // below, which is the point of that table.
    const inForce = screen.getByRole('region', { name: 'In force today' });
    expect(within(inForce).getByText('standard')).toBeInTheDocument();
    expect(
      within(inForce).queryByText('payments_plus'),
    ).not.toBeInTheDocument();
  });

  it('follows the timeline as the date moves past a change', () => {
    render(
      <SubscriptionOverview subscription={subscription} today="2026-09-20" />,
    );
    const inForce = screen.getByRole('region', { name: 'In force today' });
    expect(within(inForce).getByText('payments_plus')).toBeInTheDocument();
  });

  it('shows the anchor date, which is what fixes the billing period', () => {
    render(
      <SubscriptionOverview subscription={subscription} today="2026-09-20" />,
    );

    expect(screen.getByText(/Anchor date/)).toBeInTheDocument();
    expect(screen.getByText(/1 Sept? 2026 – 1 Oct 2026/)).toBeInTheDocument();
  });

  it('renders every interval, so a rate change is visible as history', () => {
    render(
      <SubscriptionOverview subscription={subscription} today="2026-09-20" />,
    );

    // Both rows, because "what was I charged before the upgrade" is a question
    // the invoice answers and this screen has to make askable.
    expect(screen.getByText('1.69%')).toBeInTheDocument();
    expect(screen.getByText('0.99%')).toBeInTheDocument();
  });

  it('formats a monthly fee of zero as free rather than as an amount', () => {
    render(
      <SubscriptionOverview subscription={subscription} today="2026-09-20" />,
    );

    // In the rate table: Standard is free, Payments Plus is 19.00 a month.
    const rates = screen.getByRole('region', { name: 'Rates' });
    expect(within(rates).getByText('Free')).toBeInTheDocument();
    expect(within(rates).getByText('€19.00')).toBeInTheDocument();
  });

  it('states plainly when a subscription has been suspended', () => {
    const suspended: Subscription = { ...subscription, status: 'suspended' };
    render(
      <SubscriptionOverview subscription={suspended} today="2026-09-20" />,
    );

    expect(screen.getByText(/Suspended/)).toBeInTheDocument();
  });

  it('does not claim a plan is in force when none covers today', () => {
    const ended: Subscription = {
      ...subscription,
      status: 'cancelled',
      intervals: [{ ...subscription.intervals[0], effectiveTo: '2026-09-15' }],
    };
    render(<SubscriptionOverview subscription={ended} today="2026-09-20" />);

    expect(
      screen.queryByRole('region', { name: 'In force today' }),
    ).not.toBeInTheDocument();
  });
});
