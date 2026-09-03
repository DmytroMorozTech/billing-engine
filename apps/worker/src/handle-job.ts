import type { RetryScheduler } from '@billing/platform';

import type { DunningInput, DunningStep } from './dunning.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type DunningRunner = (input: DunningInput) => Promise<DunningStep>;

export interface JobDependencies {
  runDunning: DunningRunner;
  scheduler: RetryScheduler;
}

/** As much of a BullMQ job as this needs to know about. */
export interface IncomingJob {
  name: string;
  data: unknown;
}

/**
 * Decides what a job off the queue means.
 *
 * Two job names do anything: an invoice being issued starts a collection, and
 * a retry continues one. The rest — `payment.failed`, `payment.succeeded`,
 * `dunning.exhausted` — are this service's own announcements, published for
 * whoever wants a timeline. Acting on them would run the sequence a second
 * time for every attempt.
 *
 * Kept apart from the queue itself so the dispatching can be tested without
 * Redis, and so the composition root stays a wiring file.
 */
export async function handleJob(deps: JobDependencies, job: IncomingJob): Promise<void> {
  const input = toDunningInput(job);
  if (input === null) {
    return;
  }

  const step = await deps.runDunning(input);
  if (step.next === null) {
    return;
  }

  await deps.scheduler.scheduleRetry({
    invoiceId: input.invoiceId,
    attempt: step.next.attempt,
    delayMs: step.next.waitDays * DAY_MS,
  });
}

function toDunningInput(job: IncomingJob): DunningInput | null {
  if (job.name === 'invoice.finalised') {
    // Published by the relay, so the event's own payload is nested under the
    // envelope the publisher wraps it in.
    const payload = (job.data as { payload?: { invoiceId?: unknown } } | null)?.payload;
    return { invoiceId: requireInvoiceId(payload?.invoiceId, job.name), attempt: 1 };
  }

  if (job.name === 'payment.retry') {
    const data = job.data as { invoiceId?: unknown; attempt?: unknown } | null;
    const attempt = Number(data?.attempt);
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new TypeError(`${job.name} job carries no usable attempt number`);
    }
    return { invoiceId: requireInvoiceId(data?.invoiceId, job.name), attempt };
  }

  return null;
}

/**
 * A job that cannot say which invoice it is about is a bug, not a no-op.
 * Throwing sends it to the queue's failed set, where it is visible, rather
 * than dropping a merchant's collection on the floor in silence.
 */
function requireInvoiceId(value: unknown, jobName: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${jobName} job carries no invoiceId`);
  }
  return value;
}
