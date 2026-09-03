import type { RetryScheduler } from '@billing/platform';
import { describe, expect, it, vi } from 'vitest';

import { DAY_MS, handleJob, type DunningRunner } from './handle-job.js';

/** Records what it was asked to schedule. */
class RecordingScheduler implements RetryScheduler {
  readonly scheduled: { invoiceId: string; attempt: number; delayMs: number }[] = [];

  async scheduleRetry(input: { invoiceId: string; attempt: number; delayMs: number }) {
    this.scheduled.push(input);
  }

  async close() {}
}

const settled: DunningRunner = async () => ({ status: 'succeeded', next: null });
const failedThenRetry = (waitDays: number): DunningRunner =>
  async () => ({ status: 'failed', next: { attempt: 2, waitDays } });

describe('handleJob', () => {
  it('starts collecting as soon as an invoice is issued', async () => {
    const run = vi.fn(settled);
    const scheduler = new RecordingScheduler();

    await handleJob(
      { runDunning: run, scheduler },
      { name: 'invoice.finalised', data: { payload: { invoiceId: 'inv_1' } } },
    );

    expect(run).toHaveBeenCalledWith({ invoiceId: 'inv_1', attempt: 1 });
    expect(scheduler.scheduled).toEqual([]);
  });

  it('books the next attempt when one fails', async () => {
    const scheduler = new RecordingScheduler();

    await handleJob(
      { runDunning: failedThenRetry(1), scheduler },
      { name: 'invoice.finalised', data: { payload: { invoiceId: 'inv_2' } } },
    );

    expect(scheduler.scheduled).toEqual([{ invoiceId: 'inv_2', attempt: 2, delayMs: DAY_MS }]);
  });

  it('carries the attempt number through a retry', async () => {
    const run = vi.fn(failedThenRetry(2));

    await handleJob(
      { runDunning: run, scheduler: new RecordingScheduler() },
      { name: 'payment.retry', data: { invoiceId: 'inv_3', attempt: 4 } },
    );

    expect(run).toHaveBeenCalledWith({ invoiceId: 'inv_3', attempt: 4 });
  });

  it('books nothing more once the sequence is over', async () => {
    const scheduler = new RecordingScheduler();
    const exhausted: DunningRunner = async () => ({
      status: 'failed',
      next: null,
      exhausted: true,
    });

    await handleJob(
      { runDunning: exhausted, scheduler },
      { name: 'payment.retry', data: { invoiceId: 'inv_4', attempt: 4 } },
    );

    expect(scheduler.scheduled).toEqual([]);
  });

  it('ignores the events it is not the consumer of', async () => {
    // payment.failed and the rest are announcements for whoever wants them.
    // Acting on our own announcement would run the sequence twice per attempt.
    const run = vi.fn(settled);

    for (const name of ['payment.failed', 'payment.succeeded', 'dunning.exhausted', 'whatever']) {
      await handleJob(
        { runDunning: run, scheduler: new RecordingScheduler() },
        { name, data: { payload: { invoiceId: 'inv_5' } } },
      );
    }

    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a job it cannot act on rather than guessing', async () => {
    const run = vi.fn(settled);

    await expect(
      handleJob(
        { runDunning: run, scheduler: new RecordingScheduler() },
        { name: 'invoice.finalised', data: { payload: {} } },
      ),
    ).rejects.toThrow('invoiceId');

    expect(run).not.toHaveBeenCalled();
  });
});
