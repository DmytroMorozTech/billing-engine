import { Queue } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BullMqPublisher } from './bullmq-publisher.js';

const connectionUrl = process.env.REDIS_URL;
const describeIfRedis = connectionUrl ? describe : describe.skip;

const QUEUE = 'test_outbox_publisher';

/**
 * The transport, against the real Redis.
 *
 * A mocked queue would assert that this file calls the method this file calls.
 * What is worth knowing is whether a job actually lands, and whether the
 * deterministic job id really does drop the duplicate a crashed relay produces
 * — both are BullMQ's behaviour, not ours.
 */
describeIfRedis('BullMqPublisher', () => {
  const url = connectionUrl as string;
  let publisher: BullMqPublisher;
  let inspector: Queue;

  const event = (id: number) => ({
    id,
    aggregate: `invoice:${id}`,
    eventType: 'invoice.finalised',
    payload: { number: `DE-2026-${id.toString().padStart(6, '0')}` },
  });

  beforeEach(async () => {
    inspector = new Queue(QUEUE, { connection: { url } });
    await inspector.obliterate({ force: true });
    publisher = new BullMqPublisher({ connectionUrl: url, queueName: QUEUE });
  });

  afterAll(async () => {
    await publisher?.close();
    await inspector?.close();
  });

  it('enqueues one job per event, named after the event type', async () => {
    await publisher.publish([event(1), event(2)]);

    const jobs = await inspector.getJobs(['waiting', 'delayed']);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.name)).toEqual(['invoice.finalised', 'invoice.finalised']);
    expect(jobs.map((job) => job.data.aggregate).sort()).toEqual(['invoice:1', 'invoice:2']);
  });

  it('drops the duplicate when a crashed relay publishes the same event twice', async () => {
    // The relay commits after publishing. A crash in between means the next
    // pass claims the same rows and sends them again — at-least-once, by
    // design (ADR-0005). The job id is what keeps that from becoming a second
    // payment attempt.
    await publisher.publish([event(7)]);
    await publisher.publish([event(7)]);

    expect(await inspector.getJobs(['waiting', 'delayed'])).toHaveLength(1);
  });

  it('sends nothing for an empty batch', async () => {
    await publisher.publish([]);

    expect(await inspector.getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });
});
