import type { Metadata } from 'next';

import { SubscriptionOverview } from '../../../../components/SubscriptionOverview/index.js';
import { getMerchant, getSubscription } from '../../../../lib/api.js';
import { todayIn } from '../../../../lib/money.js';

export const metadata: Metadata = { title: 'Subscription' };

const DEMO_MERCHANT_ID =
  process.env.DEMO_MERCHANT_ID ?? '00000000-0000-7000-8000-000000000001';

export default async function SubscriptionPage() {
  const [merchant, subscription] = await Promise.all([
    getMerchant(DEMO_MERCHANT_ID),
    getSubscription(DEMO_MERCHANT_ID),
  ]);

  return (
    <main className="page">
      <a href="/app/invoices">← Invoices</a>
      <SubscriptionOverview
        subscription={subscription}
        // The merchant's today, not the server's. Which plan is in force is a
        // question about their calendar, and on either side of midnight in
        // their zone the answer differs from ours.
        today={todayIn(merchant.billingTimeZone)}
      />
    </main>
  );
}
