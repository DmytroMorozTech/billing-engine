import { Body, Headline, Table } from '@sumup-oss/circuit-ui';
import type { Metadata } from 'next';

import {
  getMerchant,
  type InvoiceSummary,
  listInvoices,
} from '../../../../lib/api.js';
import { formatDate, formatMoney } from '../../../../lib/money.js';

export const metadata: Metadata = { title: 'Invoices' };

/**
 * Stands in for the session until auth exists.
 *
 * The API already scopes every read to a merchant id, so this is the only thing
 * auth has to replace here — not the query, not the page.
 */
const DEMO_MERCHANT_ID =
  process.env.DEMO_MERCHANT_ID ?? '00000000-0000-7000-8000-000000000001';

const STATUS_LABELS: Record<InvoiceSummary['status'], string> = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  uncollectible: 'Uncollectible',
  void: 'Void',
};

export default async function InvoicesPage() {
  const [merchant, { invoices }] = await Promise.all([
    getMerchant(DEMO_MERCHANT_ID),
    listInvoices(DEMO_MERCHANT_ID),
  ]);

  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2rem 1rem' }}>
      <Headline as="h1" size="l">
        Invoices
      </Headline>
      <Body color="subtle" style={{ marginBottom: '1.5rem' }}>
        {merchant.name} — {merchant.marketId}, billed in{' '}
        {merchant.billingTimeZone}
      </Body>

      {invoices.length === 0 ? (
        <Body>
          No invoices yet. The first one is issued when the period closes.
        </Body>
      ) : (
        <Table
          headers={[
            'Number',
            'Period',
            'Issued',
            'Due',
            'Status',
            { children: 'Total', align: 'right' },
          ]}
          rows={invoices.map((invoice) => [
            invoice.number ?? '—',
            `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`,
            invoice.issuedOn ? formatDate(invoice.issuedOn) : '—',
            invoice.dueOn ? formatDate(invoice.dueOn) : '—',
            STATUS_LABELS[invoice.status],
            { children: formatMoney(invoice.total), align: 'right' },
          ])}
        />
      )}
    </main>
  );
}
