import { Body, Display, Headline } from '@sumup-oss/circuit-ui';
import type { Metadata } from 'next';

import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Billing engine',
};

export default function Page() {
  return (
    <main className={styles.main}>
      <Display as="h1" size="m">
        Billing engine
      </Display>

      <Body size="l" className={styles.intro}>
        Subscriptions, usage-based commission and invoicing for a small-business
        payments platform. Every amount on every invoice can be traced back to
        the events and rates it came from.
      </Body>

      <nav className={styles.links} aria-label="Sections">
        <div className={styles.card}>
          <Headline as="h2" size="s">
            <a href="/app/invoices">Invoices</a>
          </Headline>
          <Body size="s" color="subtle">
            What a merchant was billed, and why each line comes to what it does.
          </Body>
        </div>
        <div className={styles.card}>
          <Headline as="h2" size="s">
            <a href="/app/subscription">Subscription</a>
          </Headline>
          <Body size="s" color="subtle">
            The plan in force, the anchor date that fixes the billing period,
            and every rate that has applied.
          </Body>
        </div>
      </nav>
    </main>
  );
}
