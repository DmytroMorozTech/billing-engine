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

### A posting of zero is never recorded

`ledger_entries` carries `CHECK (amount_minor <> 0)`, and `postTransfer` refuses
a zero posting before it gets that far, so the failure names the account rather
than arriving as a constraint violation.

The rule earns its place by what it catches: an amount that was supposed to be
computed and was not — a proration that rounded away, a commission line whose
rate never loaded. Written as a zero row, that is indistinguishable from a line
that is legitimately nothing.

Lines that are legitimately zero therefore are not *dropped*, they are not
*built*. `invoicePostings` is the single place that decides this, and the case it
exists for is reverse charge: a B2B merchant with a valid VAT ID owes no VAT
here, so the invoice has two postings rather than three. Relaxing the constraint
instead would have bought that one case at the price of the check on every other,
and the entries are append-only — zero rows written today could never be removed.

## Consequences

- The invariant "every balance is explainable by the entries that produced it"
  holds by construction, not by discipline.
- A property-based test generates random sequences of operations and asserts that
  the sum of all entries is zero afterwards. This is the strongest single test in
  the project. It builds its charges and refunds through `invoicePostings`, the
  same call the billing run uses, so a generated zero VAT exercises reverse
  charge rather than a shape production code would never produce.
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
