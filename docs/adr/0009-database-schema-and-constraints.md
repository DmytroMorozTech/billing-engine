# ADR-0009: Invariants belong in the database

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The previous ADRs record what must be true: money reconciles, rates never
overlap, an amount can always be explained. Recording them is not enforcing
them. Every one of those invariants can be broken by a bug in a repository
method, a seed script, or someone with `psql` and good intentions — and in a
billing system the damage is discovered weeks later, in a reconciliation report,
with no way to tell which of the two numbers was ever right.

The question is therefore where each invariant lives: in application code, where
it is easy to write and easy to bypass, or in the schema, where it is harder to
express and impossible to route around.

## Decision

**Anything that would corrupt money if violated is enforced by PostgreSQL.**
Application code may also check it, for a better error message. The database is
what makes the check true.

### Rate intervals cannot overlap

A plan change closes one interval and opens the next. Two intervals in force at
once would let a single transaction be priced twice.

```sql
EXCLUDE USING gist (
  subscription_id WITH =,
  daterange(effective_from, effective_to) WITH &&
) WHERE (superseded_at IS NULL)
```

This requires the `btree_gist` extension: GiST understands range overlap (`&&`)
natively but has no equality operator class for `uuid`, so mixing the two in one
constraint is impossible without it.

The `WHERE` clause is what makes the bitemporal model work. Superseded rows are
history and may freely contradict each other and the present; only current
knowledge has to be consistent.

### Backdated corrections are atomic, so the foreign key is deferred

`superseded_by` is `DEFERRABLE INITIALLY DEFERRED`. A correction is inherently
two statements that are only valid together, and either order breaks an
immediate constraint: insert first and the new row overlaps one that is still
current; update first and the foreign key points at a row that does not exist
yet.

Writing the test for this changed the design twice. The first version failed
because of the foreign key, which is what introduced the deferral. The second
version failed on the exclusion constraint, and that failure was correct — the
test was wrong. A backdated change does not replace one row with one row: it
**supersedes every interval it touches** and lays down a new timeline. Moving an
upgrade from 15 September back to the 5th shortens the Standard interval as well
as moving the start of the Plus one. That is now what the test does, and what
the correction routine will have to do.

### Ledger transfers balance, checked at COMMIT

```sql
CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_transfer_balances();
```

Deferred because the entries of one transfer arrive as separate statements; the
sum is only meaningful once the transfer is complete. The check is per currency,
so a transfer cannot balance by accident across two of them.

`ledger_entries` is also append-only, enforced by a trigger that raises on
`UPDATE` and `DELETE`. A mistake is corrected with a reversing entry, which
leaves both the error and the correction visible — which is what a support
engineer needs. Silently editable history is not evidence.

### Invoice numbering is a row, not a sequence

`invoice_sequences` is an ordinary table locked with `SELECT ... FOR UPDATE`
inside the transaction that inserts the invoice. A Postgres `SEQUENCE` is
explicitly non-transactional: a rolled-back transaction burns its number and
leaves a gap. Gapless numbering per legal entity is a legal requirement in
Germany and Italy, so the slower, correct mechanism is the only option.

### Terms are copied into the interval, not joined from the catalogue

`rate_intervals` carries its own `monthly_fee_minor` and rate columns rather
than reading them from `plans`. Editing the catalogue must never silently
reprice a period that has already been invoiced, and "recomputing a closed
period is byte-identical" has to survive a price change.

### Local dates are frozen at ingest

`transactions.occurred_on` is the local calendar date in the merchant's billing
time zone, computed once when the transaction is recorded and never recalculated.

Denormalised because rating is by local date while the time zone lives on the
merchant — a generated column cannot reach another table. Frozen because a
merchant who changes their billing time zone must not retroactively alter
invoices already issued; the new zone applies from the change onward.

**Consequence for the UI:** the merchant settings screen has to say this
explicitly. Otherwise a merchant changes time zone, sees no effect on past
invoices, and files a support ticket.

### Money crossing the driver boundary

Two `node-postgres` type parsers, installed once per process:

- `BIGINT` is returned as a string by default, since 64 bits do not always fit a
  double. Ours always do — every amount is validated as a safe integer before it
  is written — so it is parsed back to a number, with a guard that throws rather
  than silently losing precision.
- `DATE` is returned as a JS `Date` in the server's local zone by default, which
  is precisely the bug this project exists to avoid: `2026-09-01` becomes
  `2026-08-31T22:00Z` for anyone west of UTC. It is kept as the ISO string it
  already is, so `Temporal.PlainDate.from(row.occurred_on)` simply works.
- `NUMERIC` throws on sight. No column should be `NUMERIC` (ADR-0001), and a
  loud failure is better than a silent string.

### `packages/platform` for adapters

`SystemClock` cannot live in `packages/domain` — the lint rules enforcing
ADR-0002 forbid `Temporal.Now` there, correctly. Duplicating it into each app's
composition root would satisfy the rule while eroding the intent behind it. It
lives in `packages/platform` alongside id generation, which is the same kind of
thing: a small adapter over something ambient. This extends the package list in
[ADR-0007](0007-repository-structure.md) rather than changing its decision.

Ids are UUIDv7 generated by the application, not the database: an outbox row and
the aggregate it describes are written in one transaction and need the id before
the `INSERT` (ADR-0005), and an idempotent handler must compute the same id from
the same input on a retry (ADR-0004). Neither is possible if the database
assigns it.

## Consequences

- These invariants hold against any writer, including migrations, seed scripts
  and manual `psql` sessions — not only against code that goes through the
  repositories.
- Integration tests need a real PostgreSQL. They skip themselves when
  `DATABASE_URL` is absent so the default test run stays fast and offline; CI
  provides one and runs them.
- Deferred constraints move failures to `COMMIT`, which makes stack traces less
  direct. Accepted: the alternative is a check that is either wrong or absent.
- The exclusion constraint costs a GiST index on a hot table. At this scale it
  is irrelevant, and correctness is not the place to pre-optimise.

## Alternatives considered

**Enforce everything in the application, keep the schema plain.** Simpler
migrations, easier local reasoning, and one careless `INSERT` away from an
unbalanced ledger with no way to tell when it happened.

**A ledger with a `balance` column and no zero-sum rule.** Rejected in
[ADR-0003](0003-balance-derived-from-ledger.md) for the same reason: it offers
nothing to reconcile against when it is wrong.
