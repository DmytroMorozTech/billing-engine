import type { Database } from '@billing/db';
import {
  applyPlanChange,
  createMerchant,
  createSubscription,
  currentRateIntervals,
  ensureMerchantAccounts,
  ingestTransaction,
  issueCreditNote,
  netCharged,
  openInitialInterval,
  planTerms,
  vatTreatmentFor,
  merchantContext,
} from '@billing/db';
import type { BillingPeriod, Money } from '@billing/domain';
import { buildInvoice, money, prepareCorrection, preparePlanChange } from '@billing/domain';
import type { IdGenerator, PspClient } from '@billing/platform';
import type { Kysely } from 'kysely';
import { Temporal } from 'temporal-polyfill';

import { runBillingCycle } from './billing-run.js';
import { processDunning } from './dunning.js';

export interface SeedDependencies {
  db: Kysely<Database>;
  ids: IdGenerator;
  psp: PspClient;
}

export interface SeededMerchant {
  story: string;
  merchantId: string;
  subscriptionId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  totalMinor: number;
}

/** September 2026, the month every story is told in. */
const PERIOD: BillingPeriod = {
  start: Temporal.PlainDate.from('2026-09-01'),
  end: Temporal.PlainDate.from('2026-10-01'),
};

const ISSUED_ON = PERIOD.end;
const DUE_ON = Temporal.PlainDate.from('2026-10-15');
const TIME_ZONE = 'Europe/Berlin';

const eur = (amount: number) => money(amount, 'EUR');

/**
 * Demo data, built by running the system rather than by writing rows.
 *
 * Every merchant here is created, charged, billed and collected through the
 * same functions production uses. A seed that inserts finished rows only ever
 * proves itself right: it drifts from the code the moment a calculation
 * changes, and it cannot produce a state the real path could not reach.
 *
 * Deterministic on purpose. Fixed identifiers, a fixed month, volumes chosen
 * rather than random — running it twice gives the same database, which is what
 * lets a demo be rehearsed and a video be shot twice.
 */
export async function seedDemoData(deps: SeedDependencies): Promise<SeededMerchant[]> {
  return [
    await upgradedMidCycle(deps),
    await reverseCharged(deps),
    await outsideScope(deps),
    await intoSuspension(deps),
    await recoveredOnThirdAttempt(deps),
    await correctedAfterTheFact(deps),
  ];
}

/** A merchant, its subscription on the free plan, and its ledger accounts. */
async function newMerchant(
  deps: SeedDependencies,
  story: string,
  options: { marketId?: string; vatId?: string | null; name: string },
): Promise<{ merchantId: string; subscriptionId: string }> {
  const merchantId = deps.ids.next();
  const subscriptionId = deps.ids.next();

  await createMerchant(deps.db, {
    id: merchantId,
    legalEntityId: 'de-gmbh',
    marketId: options.marketId ?? 'DE',
    currency: 'EUR',
    email: `${story}@example.com`,
    name: options.name,
    billingTimeZone: TIME_ZONE,
    vatId: options.vatId ?? null,
  });
  await createSubscription(deps.db, { id: subscriptionId, merchantId, anchorDate: PERIOD.start });
  await ensureMerchantAccounts(deps.db, merchantId, 'EUR');

  const standard = await planTerms(deps.db, 'standard');
  await deps.db.transaction().execute((tx) =>
    openInitialInterval(tx, subscriptionId, {
      ...standard,
      id: deps.ids.next(),
      effectiveFrom: PERIOD.start,
      effectiveTo: null,
    }),
  );

  return { merchantId, subscriptionId };
}

async function processVolume(
  deps: SeedDependencies,
  merchantId: string,
  gross: Money,
  on: string,
): Promise<void> {
  await ingestTransaction(
    deps.db,
    {
      id: deps.ids.next(),
      merchantId,
      gross,
      channel: 'in_person',
      occurredAt: Temporal.Instant.from(on),
    },
    TIME_ZONE,
  );
}

async function upgradeOn(
  deps: SeedDependencies,
  subscriptionId: string,
  day: string,
): Promise<void> {
  const plan = preparePlanChange({
    currentIntervals: await currentRateIntervals(deps.db, subscriptionId),
    newTerms: await planTerms(deps.db, 'payments_plus'),
    effectiveFrom: Temporal.PlainDate.from(day),
    today: Temporal.PlainDate.from(day),
    nextId: () => deps.ids.next(),
  });

  await deps.db.transaction().execute((tx) => applyPlanChange(tx, subscriptionId, plan));
}

const bill = (deps: SeedDependencies, subscriptionId: string) =>
  runBillingCycle({ db: deps.db, ids: deps.ids }, {
    subscriptionId,
    period: PERIOD,
    issuedOn: ISSUED_ON,
    dueOn: DUE_ON,
  });

/**
 * Volume that makes the invoice total end in the given two digits.
 *
 * The simulator decides an outcome from the amount it is asked to collect, so a
 * demo that needs a payment to fail needs an invoice that ends in `01`. Searched
 * rather than hand-computed: the number depends on the rating rules, and a
 * constant here would quietly stop meaning what it says the first time a rate
 * changes.
 */
function volumeEndingIn(digits: number, intervals: Awaited<ReturnType<typeof currentRateIntervals>>): Money {
  for (let gross = 100_000; gross < 100_000 + 20_000; gross += 1) {
    const draft = buildInvoice({
      period: PERIOD,
      currency: 'EUR',
      intervals,
      transactions: [
        {
          id: 'probe',
          gross: eur(gross),
          channel: 'in_person',
          occurredOn: Temporal.PlainDate.from('2026-09-10'),
        },
      ],
      vat: { kind: 'standard', rateBps: 1900 },
    });

    if (draft.total.amount % 100 === digits) {
      return eur(gross);
    }
  }

  throw new Error(`No volume in range produces a total ending in ${digits}`);
}

/** The worked example from ADR-0006: upgrade mid-cycle, invoice, pay it. */
async function upgradedMidCycle(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'upgraded-mid-cycle';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    name: 'Cafe Kreuzberg',
  });

  await processVolume(deps, merchantId, eur(413_000), '2026-09-09T22:30:00Z');
  await processVolume(deps, merchantId, eur(387_000), '2026-09-20T09:00:00Z');
  await upgradeOn(deps, subscriptionId, '2026-09-15');

  const invoice = await bill(deps, subscriptionId);
  await collect(deps, invoice.invoiceId);

  return summarise(story, merchantId, subscriptionId, invoice);
}

/** An Italian business with a VAT ID: the liability is theirs, so no VAT. */
async function reverseCharged(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'reverse-charge';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    marketId: 'IT',
    vatId: 'IT12345678901',
    name: 'Trattoria Milano',
  });

  await processVolume(deps, merchantId, eur(250_000), '2026-09-12T10:00:00Z');
  const invoice = await bill(deps, subscriptionId);
  await collect(deps, invoice.invoiceId);

  return summarise(story, merchantId, subscriptionId, invoice);
}

/** A British business: outside the scope of EU VAT, which is not reverse charge. */
async function outsideScope(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'outside-scope';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    marketId: 'GB',
    vatId: 'GB123456789',
    name: 'Brighton Books',
  });

  await processVolume(deps, merchantId, eur(180_000), '2026-09-14T10:00:00Z');
  const invoice = await bill(deps, subscriptionId);
  await collect(deps, invoice.invoiceId);

  return summarise(story, merchantId, subscriptionId, invoice);
}

/** Four failed attempts, then suspension. The sequence the demo is about. */
async function intoSuspension(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'into-suspension';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    name: 'Späti am Kotti',
  });

  const intervals = await currentRateIntervals(deps.db, subscriptionId);
  await processVolume(deps, merchantId, volumeEndingIn(1, intervals), '2026-09-11T10:00:00Z');

  const invoice = await bill(deps, subscriptionId);
  await runDunning(deps, invoice.invoiceId);

  return summarise(story, merchantId, subscriptionId, invoice);
}

/** Two failures and then the money arrives. Recovery is part of the story. */
async function recoveredOnThirdAttempt(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'recovered';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    name: 'Buchhandlung Prenzlauer Berg',
  });

  const intervals = await currentRateIntervals(deps.db, subscriptionId);
  await processVolume(deps, merchantId, volumeEndingIn(2, intervals), '2026-09-13T10:00:00Z');

  const invoice = await bill(deps, subscriptionId);
  await runDunning(deps, invoice.invoiceId);

  return summarise(story, merchantId, subscriptionId, invoice);
}

/** The upgrade was recorded a week late; the correction gives the money back. */
async function correctedAfterTheFact(deps: SeedDependencies): Promise<SeededMerchant> {
  const story = 'corrected';
  const { merchantId, subscriptionId } = await newMerchant(deps, story, {
    name: 'Weinhandlung Mitte',
  });

  await processVolume(deps, merchantId, eur(413_000), '2026-09-08T10:00:00Z');
  await processVolume(deps, merchantId, eur(387_000), '2026-09-18T10:00:00Z');
  await upgradeOn(deps, subscriptionId, '2026-09-15');

  const invoice = await bill(deps, subscriptionId);
  await collect(deps, invoice.invoiceId);

  // The merchant upgraded on the 5th; it reached us on the 15th. Moving it back
  // re-rates the volume in between, and the difference is owed to them.
  await upgradeOn(deps, subscriptionId, '2026-09-05');

  const merchant = await merchantContext(deps.db, merchantId);
  const correction = prepareCorrection({
    period: PERIOD,
    issued: await netCharged(deps.db, invoice.invoiceId as string),
    recomputed: buildInvoice({
      period: PERIOD,
      currency: merchant.currency,
      intervals: await currentRateIntervals(deps.db, subscriptionId),
      transactions: await uninvoiced(deps, merchantId),
      vat: vatTreatmentFor(merchant),
    }),
  });

  if (correction.kind === 'credit') {
    await deps.db.transaction().execute((tx) =>
      issueCreditNote(tx, {
        id: deps.ids.next(),
        merchantId,
        invoiceId: invoice.invoiceId as string,
        legalEntityId: merchant.legalEntityId,
        draft: correction.draft,
        lineIds: correction.draft.lines.map(() => deps.ids.next()),
        transferId: deps.ids.next(),
        issuedOn: Temporal.PlainDate.from('2026-10-05'),
      }),
    );
  }

  return summarise(story, merchantId, subscriptionId, invoice);
}

/**
 * The transactions the invoice was built from.
 *
 * Read back rather than remembered: they are marked as invoiced by the run, so
 * recomputing the period has to look at what that invoice claimed rather than
 * at what is still uninvoiced, which is nothing.
 */
async function uninvoiced(deps: SeedDependencies, merchantId: string) {
  const rows = await deps.db
    .selectFrom('transactions')
    .select(['id', 'gross_minor', 'currency', 'channel', 'occurred_on'])
    .where('merchant_id', '=', merchantId)
    .orderBy('occurred_on')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    gross: money(row.gross_minor, row.currency as 'EUR'),
    channel: row.channel,
    occurredOn: Temporal.PlainDate.from(row.occurred_on),
  }));
}

/** One collection attempt, for the merchants whose payment simply works. */
async function collect(deps: SeedDependencies, invoiceId: string | null): Promise<void> {
  if (invoiceId === null) {
    return;
  }
  await processDunning({ db: deps.db, psp: deps.psp, ids: deps.ids }, { invoiceId, attempt: 1 });
}

/** The whole sequence, played to its end without waiting for the delays. */
async function runDunning(deps: SeedDependencies, invoiceId: string | null): Promise<void> {
  if (invoiceId === null) {
    return;
  }

  let attempt = 1;
  for (;;) {
    const step = await processDunning(
      { db: deps.db, psp: deps.psp, ids: deps.ids },
      { invoiceId, attempt },
    );
    if (step.next === null) {
      return;
    }
    attempt = step.next.attempt;
  }
}

function summarise(
  story: string,
  merchantId: string,
  subscriptionId: string,
  invoice: { invoiceId: string | null; number: string | null; total: Money },
): SeededMerchant {
  return {
    story,
    merchantId,
    subscriptionId,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.number,
    totalMinor: invoice.total.amount,
  };
}
