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
