import { Body, Compact, Headline, Table } from '@sumup-oss/circuit-ui';

import type { Invoice } from '../../lib/api.js';
import { formatDate, formatMoney } from '../../lib/money.js';
import { DerivationTree } from '../DerivationTree/index.js';

import classes from './InvoiceDetail.module.css';

export interface InvoiceDetailProps {
  invoice: Invoice;
}

const STATUS_LABELS: Record<Invoice['status'], string> = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  uncollectible: 'Uncollectible',
  void: 'Void',
};

/**
 * Why the VAT is what it is.
 *
 * Two of these come to zero and they are different in law — a reverse charge
 * shifts the liability to a customer who must account for it, an out-of-scope
 * supply never entered the EU VAT system at all. "Because the rate was zero"
 * is not an answer an auditor accepts, so the invoice says which applied.
 */
const VAT_EXPLANATIONS: Record<Invoice['vatTreatment'], string> = {
  standard: 'Standard rate',
  reverse_charge:
    'Reverse charge — VAT is accounted for by the customer under the EU VAT Directive',
  outside_scope: 'Outside the scope of EU VAT — supply to a non-EU customer',
};

export function InvoiceDetail({ invoice }: InvoiceDetailProps) {
  const credited = invoice.netTotal.amount !== invoice.total.amount;

  return (
    <article>
      <header className={classes.header}>
        <Headline as="h1" size="l">
          {invoice.number ?? 'Draft invoice'}
        </Headline>
        <Body color="subtle">
          {`${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)} · ${STATUS_LABELS[invoice.status]}`}
        </Body>
        {invoice.issuedOn && invoice.dueOn && (
          <Compact size="s" color="subtle">
            {`Issued ${formatDate(invoice.issuedOn)}, due ${formatDate(invoice.dueOn)}`}
          </Compact>
        )}
      </header>

      <section className={classes.section}>
        <Headline as="h2" size="s">
          Lines
        </Headline>
        {invoice.lines.map((line) => (
          <div key={line.position} className={classes.line}>
            <div className={classes.lineHead}>
              <Body>{line.description}</Body>
              <Body>{formatMoney(line.amount)}</Body>
            </div>
            <DerivationTree derivation={line.derivation} />
          </div>
        ))}
      </section>

      <section className={classes.section}>
        <Headline as="h2" size="s">
          Total
        </Headline>
        <dl className={classes.totals}>
          <dt>
            <Body>Subtotal</Body>
          </dt>
          <dd>
            <Body>{formatMoney(invoice.subtotal)}</Body>
          </dd>

          <dt>
            <Body>VAT</Body>
            <Compact size="s" color="subtle">
              {VAT_EXPLANATIONS[invoice.vatTreatment]}
            </Compact>
          </dt>
          <dd>
            <Body>{formatMoney(invoice.vat)}</Body>
          </dd>

          <dt>
            <Body weight="bold">Billed</Body>
          </dt>
          <dd>
            <Body weight="bold">{formatMoney(invoice.total)}</Body>
          </dd>

          {credited && (
            <>
              <dt>
                <Body weight="bold">Still charged</Body>
                <Compact size="s" color="subtle">
                  After credit notes. The invoice itself is never rewritten.
                </Compact>
              </dt>
              <dd>
                <Body weight="bold">{formatMoney(invoice.netTotal)}</Body>
              </dd>
            </>
          )}
        </dl>
      </section>

      {invoice.creditNotes.length > 0 && (
        <section className={classes.section}>
          <Headline as="h2" size="s">
            Credit notes
          </Headline>
          <Table
            headers={[
              'Number',
              'Issued',
              { children: 'Amount', align: 'right' },
            ]}
            rows={invoice.creditNotes.map((note) => [
              note.number,
              formatDate(note.issuedOn),
              { children: formatMoney(note.total), align: 'right' as const },
            ])}
          />
        </section>
      )}

      {invoice.paymentAttempts.length > 0 && (
        <section className={classes.section}>
          <Headline as="h2" size="s">
            Payment attempts
          </Headline>
          <Table
            headers={['Attempt', 'When', 'Result', 'Reason']}
            rows={invoice.paymentAttempts.map((attempt) => [
              String(attempt.attempt),
              attempt.attemptedAt,
              attempt.status === 'succeeded' ? 'Succeeded' : 'Failed',
              attempt.declineCode ?? '—',
            ])}
          />
        </section>
      )}
    </article>
  );
}
