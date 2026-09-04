import { Body, Compact, Headline, Table } from '@sumup-oss/circuit-ui';

import type { RateInterval, Subscription } from '../../lib/api.js';
import { formatDate, formatMoney, formatRate } from '../../lib/money.js';

import classes from './SubscriptionOverview.module.css';

export interface SubscriptionOverviewProps {
  subscription: Subscription;
  /** Today in the merchant's billing time zone, as an ISO date. */
  today: string;
}

const STATUS_LABELS: Record<Subscription['status'], string> = {
  active: 'Active',
  past_due: 'Past due',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
};

const CHANNEL_LABELS = {
  in_person: 'In person',
  online: 'Online',
  moto: 'MOTO',
} as const;

/**
 * The interval covering a date.
 *
 * Not simply the open-ended one: a merchant who has scheduled an upgrade for
 * next week is still on the old plan today, and the invoice they receive will
 * say so. Dates compare correctly as ISO strings, which is the point of the
 * format.
 */
function intervalOn(
  intervals: readonly RateInterval[],
  date: string,
): RateInterval | undefined {
  return intervals.find(
    (interval) =>
      interval.effectiveFrom <= date &&
      (interval.effectiveTo === null || interval.effectiveTo > date),
  );
}

function feeLabel(interval: RateInterval): string {
  return interval.monthlyFee.amount === 0
    ? 'Free'
    : formatMoney(interval.monthlyFee);
}

export function SubscriptionOverview({
  subscription,
  today,
}: SubscriptionOverviewProps) {
  const current = intervalOn(subscription.intervals, today);

  return (
    <article>
      <header className={classes.header}>
        <Headline as="h1" size="l">
          Subscription
        </Headline>
        <Body color="subtle">{STATUS_LABELS[subscription.status]}</Body>
      </header>

      {current && (
        <section className={classes.section} aria-labelledby="in-force">
          <Headline as="h2" size="s" id="in-force">
            In force today
          </Headline>
          <dl className={classes.facts}>
            <dt>
              <Body>Plan</Body>
            </dt>
            <dd>
              <Body>{current.planId}</Body>
            </dd>
            <dt>
              <Body>Monthly fee</Body>
            </dt>
            <dd>
              <Body>{feeLabel(current)}</Body>
            </dd>
          </dl>
        </section>
      )}

      <section className={classes.section} aria-labelledby="billing-cycle">
        <Headline as="h2" size="s" id="billing-cycle">
          Billing cycle
        </Headline>
        <dl className={classes.facts}>
          <dt>
            <Body>Anchor date</Body>
            <Compact size="s" color="subtle">
              Every period starts on this day, in the merchant&rsquo;s own time
              zone. It is fixed at signup and does not move.
            </Compact>
          </dt>
          <dd>
            <Body>{formatDate(subscription.anchorDate)}</Body>
          </dd>
          <dt>
            <Body>Current period</Body>
          </dt>
          <dd>
            <Body>
              {`${formatDate(subscription.currentPeriod.start)} – ${formatDate(subscription.currentPeriod.end)}`}
            </Body>
          </dd>
        </dl>
      </section>

      <section className={classes.section} aria-labelledby="rates">
        <Headline as="h2" size="s" id="rates">
          Rates
        </Headline>
        <Body size="s" color="subtle" className={classes.note}>
          More than one row means the rate changed. Volume keeps the rate that
          was in force on the day it was processed, so an upgrade never reprices
          what came before it.
        </Body>
        <Table
          headers={[
            'Plan',
            'From',
            'To',
            { children: 'Monthly', align: 'right' },
            { children: CHANNEL_LABELS.in_person, align: 'right' },
            { children: CHANNEL_LABELS.online, align: 'right' },
            { children: CHANNEL_LABELS.moto, align: 'right' },
          ]}
          rows={subscription.intervals.map((interval) => [
            interval.planId,
            formatDate(interval.effectiveFrom),
            interval.effectiveTo ? formatDate(interval.effectiveTo) : 'Open',
            { children: feeLabel(interval), align: 'right' as const },
            {
              children: formatRate(interval.rates.in_person),
              align: 'right' as const,
            },
            {
              children: formatRate(interval.rates.online),
              align: 'right' as const,
            },
            {
              children: formatRate(interval.rates.moto),
              align: 'right' as const,
            },
          ])}
        />
      </section>
    </article>
  );
}
