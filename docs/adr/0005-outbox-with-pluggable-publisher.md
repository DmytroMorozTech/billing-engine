# ADR-0005: Transactional outbox with a pluggable publisher

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

When an invoice is finalised, other parts of the system have to react: schedule a
payment attempt, notify the merchant, update reporting. The naive implementation
publishes the event right after committing the transaction — which loses the
event if the process dies in between, and emits a phantom event if the publish
happens before a commit that later rolls back.

Separately: this project needs **delayed execution** ("retry this payment in three
days"), not a high-throughput event bus between teams. Those are different
problems with different right answers.

## Decision

**Two decisions, deliberately separated.**

### 1. Events are written to an outbox table inside the business transaction

```sql
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  aggregate    TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ
);
```

The invoice row and its `invoice.finalised` outbox row commit together. An event
cannot be lost if the transaction succeeded, and cannot escape if it rolled back.
A separate publisher process polls for unpublished rows, hands them to a transport,
and marks them published. Delivery is at-least-once, so **every consumer must be
idempotent** — see [ADR-0004](0004-idempotency-in-postgres.md).

### 2. The transport is behind an interface

```ts
interface OutboxPublisher {
  publish(events: OutboxEvent[]): Promise<void>;
}
```

The default implementation enqueues into **BullMQ** (Redis). Swapping to Kafka
means writing one more implementation and changing one line in the composition
root.

**Why BullMQ and not Kafka**, which is the reflexive choice for anything described
as an "event":

| | Infrastructure | Delayed jobs | Verdict |
|---|---|---|---|
| **BullMQ** (Redis) | Redis already present | native | **chosen** |
| pg-boss (Postgres) | nothing extra | native | also fine |
| RabbitMQ | +1 service | only via workarounds | no |
| Kafka | +1 heavy service | none | no |

Kafka solves a problem this project does not have: streaming data between dozens
of teams that each own their own services and want to consume each other's data
without asking. That is a genuine and common use for it. Inside a single service
it adds operational weight and no capability. What is needed here is a timer, and
BullMQ has one natively, plus retries with exponential backoff and a dead-letter
queue.

The valuable part of Kafka's ecosystem — the outbox pattern — is adopted without
adopting Kafka.

## Consequences

- No event is ever lost or phantom-published.
- Consumers must be idempotent. This is a real constraint, enforced by
  deterministic `jobId`s and by handlers that check state before acting.
- The publisher is one more process to run. It lives inside the worker container.
- After N failures a job lands in `failed` rather than disappearing. The support
  console has a "stuck jobs" screen — the first place an on-call engineer looks.
- Polling the outbox adds a small constant query load. `LISTEN/NOTIFY` is the
  upgrade path if it ever matters.

## Alternatives considered

**Publish after commit, no outbox.** Simpler and loses events. The failure mode is
silent, which is the worst kind.

**Change data capture (Debezium).** Robust and appropriate at a different scale;
here it means running Kafka Connect to avoid writing a table and a poll loop.
