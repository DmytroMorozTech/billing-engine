# ADR-0004: Idempotency keys live in PostgreSQL, not Redis

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Every write endpoint that moves money must be safe to retry. Clients time out,
proxies retry, and queue workers guarantee at-least-once delivery — so the same
"charge this merchant" request will arrive twice, and it must charge once.

The tempting implementation is a Redis key with a TTL: fast, self-expiring, and
Redis is already in the stack for locks and queues.

**This is wrong, and the reason is worth writing down.**

Redis and PostgreSQL are separate systems, so a write to each cannot be atomic.
The failure sequence is:

```
1. write idempotency key to Redis          → ok
2. begin Postgres transaction
3. insert payment, write ledger entries
4. commit                                  → FAILS (deadlock, crash, timeout)
```

The key now says "handled" while no payment exists. The retry is rejected as a
duplicate, and the merchant is never charged. Reverse the order and the mirror
bug appears: the payment commits, the Redis write fails, the retry charges twice.
Redis persistence is also best-effort — an unlucky restart drops recent keys and
a replayed request becomes a second, real charge.

## Decision

**The idempotency record is a PostgreSQL row written in the same transaction as
the action it protects.**

```sql
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  endpoint        TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INT         NOT NULL,
  response_body   JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
);
```

Flow for a write request carrying `Idempotency-Key`:

1. Open a transaction.
2. `INSERT ... ON CONFLICT (key) DO NOTHING`.
3. If the insert found an existing row: compare `request_hash`. Same payload →
   **return the stored response verbatim**. Different payload → `422`, because
   the client reused a key for a different request.
4. If the insert claimed the key: perform the action, write the stored response
   into the same row, commit.

Because the key and the effect commit together, the two can never disagree. A
rolled-back transaction takes the key with it, and the retry proceeds correctly.

A replay returns **the same response body and status as the original**, not
`409 Conflict`. A client that retries because it never saw the first response
needs the result, not an error.

`Idempotency-Key` is required on every write endpoint, enforced by JSON Schema at
the Fastify layer.

Redis may still hold a short-lived "this key is in flight" lock to shed duplicate
concurrent work early. That is an optimisation. It is never consulted to decide
whether an action already happened.

## Consequences

- Correct across process crashes, Redis restarts, and rollbacks.
- Costs one extra row per write, plus a periodic cleanup job for rows older than
  the retention window (24h is enough for client retries).
- Queue handlers get the same protection through a deterministic `jobId`
  (`retry:${invoiceId}:2`), which prevents the duplicate from being enqueued in
  the first place.
- The failure sequence above is written out in full deliberately. The Redis
  approach is not obviously wrong, which is exactly why it gets shipped; the
  reasoning has to be recorded or it will be re-litigated.

## Alternatives considered

**Redis with TTL.** Rejected for the reasons above. Fast and wrong.

**Natural idempotency via unique constraints** (e.g. one invoice per subscription
per period). Genuinely good where it applies, and used in addition to this
mechanism — but it cannot cover endpoints whose effect is not a single uniquely
constrained row.
