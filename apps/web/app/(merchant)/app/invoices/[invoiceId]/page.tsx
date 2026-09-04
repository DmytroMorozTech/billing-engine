/*
 * Plain anchors rather than `next/link`.
 *
 * The Circuit UI template sets `moduleResolution: NodeNext`, and Next ships
 * `next/link` as CommonJS with no `exports` field, so TypeScript resolves the
 * default import to the module namespace and refuses it as a JSX component.
 * The fixes are worse than the problem: `moduleResolution: bundler` breaks the
 * `.js` extensions this workspace (and its Jest moduleNameMapper) relies on.
 *
 * The cost is a full navigation instead of a client-side one. Every page here
 * is server-rendered and fetches with `no-store`, so a full load is what
 * happens either way; what is lost is prefetching. Worth revisiting if the
 * portal grows enough for that to be felt.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation.js';

import { InvoiceDetail } from '../../../../../components/InvoiceDetail/index.js';
import { ApiError, getInvoice, type Invoice } from '../../../../../lib/api.js';

export const metadata: Metadata = { title: 'Invoice' };

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;

  let invoice: Invoice;
  try {
    invoice = await getInvoice(invoiceId);
  } catch (error) {
    // A 404 from the API is a 404 here. Anything else is a real failure and
    // belongs in the error boundary rather than dressed up as "not found".
    if (error instanceof ApiError && error.problem.status === 404) {
      notFound();
    }
    throw error;
  }

  return (
    <main className="page">
      <a href="/app/invoices">← All invoices</a>
      <InvoiceDetail invoice={invoice} />
    </main>
  );
}
