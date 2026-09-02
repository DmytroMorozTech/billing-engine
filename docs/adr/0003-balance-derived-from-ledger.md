# ADR-0003: Wallet balance is derived, never stored

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The obvious way to model a merchant wallet is a `balance` column updated on every
movement. It is also the way that produces money that does not add up.

A stored balance is a cache with no source of truth behind it. When it drifts —
a failed transaction that updated the balance but not the movement, a concurrent
write that lost an update, a retried job that applied a credit twice — there is
nothing to reconcile against. The only remaining question is which number to
believe, and there is no way to answer it.

## Decision

**The wallet is a double-entry ledger.** Every movement of money writes at least
two rows: one debit, one credit, equal in magnitude. The sum of all ledger entries
across the system is always zero.

```
entry_id | account              | amount | currency | transfer_id
---------+----------------------+--------+----------+------------
       1 | merchant:42:wallet   |  -1900 | EUR      | t_88
       2 | platform:revenue     |  +1900 | EUR      | t_88
```

**Balance is a query**, not a column:

```sql
SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
WHERE account = $1 AND currency = $2;
```

Ledger entries are **append-only**. There is no `UPDATE`, no `DELETE`. A mistake
is corrected by writing a reversing entry, which leaves both the error and the
correction visible in the history — which is what a support agent needs to see.

Every write is wrapped in a single database transaction, so a transfer either
lands completely or not at all.

## Consequences

- The invariant "every balance is explainable by the entries that produced it"
  holds by construction, not by discipline.
- A property-based test generates random sequences of operations and asserts that
  the sum of all entries is zero afterwards. This is the strongest single test in
  the project.
- Reading a balance costs an aggregate query. At this project's scale that is
  irrelevant. If it ever mattered, the fix is a materialised view or a snapshot
  row with a `computed_up_to_entry_id` watermark — a cache that can be rebuilt and
  verified, which a bare `balance` column can never be.
- Support tooling gets the merchant timeline almost for free: the ledger already
  is the timeline.

## Alternatives considered

**`balance` column with row-level locking.** Correct under contention if done
carefully, but it discards history and offers nothing to reconcile against when
it is wrong.

**Event sourcing the whole domain.** The ledger already is an event-sourced view
of money. Extending that pattern to subscriptions and plans would add
considerable machinery for no additional guarantee about the part that matters.
