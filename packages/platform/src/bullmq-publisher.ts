import { Queue } from 'bullmq';

import type { OutboxPublisher, PublishableEvent } from './outbox-publisher.js';

export interface BullMqPublisherOptions {
  /** `redis://host:port`. */
  connectionUrl: string;
  /** Defaults to `outbox`. One queue; the event type is the job name. */
  queueName?: string;
}

/**
 * Publishes outbox events as BullMQ jobs.
 *
 * BullMQ rather than Kafka because what this system needs from a transport is a
 * timer — "retry this payment in three days" — and Redis is already running.
 * ADR-0005 has the comparison.
 *
 * The job id is derived from the outbox row id, which is what makes
 * at-least-once delivery survivable: the relay can hand the same event over
 * twice after a crash between publish and commit, and the second attempt is
 * dropped by BullMQ rather than becoming a second payment attempt. Idempotency
 * of the handler is still required — this only removes the cheapest duplicate.
 */
export class BullMqPublisher implements OutboxPublisher {
  readonly #queue: Queue;

  constructor(options: BullMqPublisherOptions) {
    this.#queue = new Queue(options.queueName ?? 'outbox', {
      connection: { url: options.connectionUrl },
    });
  }

  async publish(events: readonly PublishableEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await this.#queue.addBulk(
      events.map((event) => ({
        name: event.eventType,
        data: { aggregate: event.aggregate, payload: event.payload },
        // Hyphen, not a colon: BullMQ rejects a colon in a custom id, because
        // that is the separator of its own Redis keys.
        opts: { jobId: `outbox-${event.id}` },
      })),
    );
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

/**
 * Schedules the next collection attempt.
 *
 * Separate from the publisher because it is a different act: the publisher
 * forwards something that already happened, while this asks for something to
 * happen later. They share a queue and nothing else.
 */
export interface RetryScheduler {
  scheduleRetry(input: { invoiceId: string; attempt: number; delayMs: number }): Promise<void>;
  close(): Promise<void>;
}

export class BullMqRetryScheduler implements RetryScheduler {
  readonly #queue: Queue;

  constructor(options: BullMqPublisherOptions) {
    this.#queue = new Queue(options.queueName ?? 'outbox', {
      connection: { url: options.connectionUrl },
    });
  }

  async scheduleRetry(input: {
    invoiceId: string;
    attempt: number;
    delayMs: number;
  }): Promise<void> {
    await this.#queue.add(
      'payment.retry',
      { invoiceId: input.invoiceId, attempt: input.attempt },
      {
        delay: input.delayMs,
        // Derived from what the retry is for, so a handler that runs twice
        // cannot queue the same attempt twice. Hyphens because BullMQ reserves
        // the colon for its own keys.
        jobId: `retry-${input.invoiceId}-${input.attempt}`,
      },
    );
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}
