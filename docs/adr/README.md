# Architecture Decision Records

Short documents recording *why* a decision was made, not just what it was.
Format: Status → Context → Decision → Consequences → Alternatives considered.

An ADR is immutable once accepted. If a decision changes, a new ADR supersedes
the old one and the old one is marked `Superseded by ADR-XXXX`.

| # | Title | Status |
|---|---|---|
| [0001](0001-money-as-integer-minor-units.md) | Money is an integer in minor units | Accepted |
| [0002](0002-injectable-clock-and-temporal.md) | Time is injected; dates use Temporal | Accepted |
| [0003](0003-balance-derived-from-ledger.md) | Wallet balance is derived, never stored | Accepted |
| [0004](0004-idempotency-in-postgres.md) | Idempotency keys live in PostgreSQL, not Redis | Accepted |
| [0005](0005-outbox-with-pluggable-publisher.md) | Transactional outbox with a pluggable publisher | Accepted |
| [0006](0006-plan-model-and-mid-cycle-rate-change.md) | Plans buy a rate; rate applies by transaction date | Accepted |
| [0007](0007-repository-structure.md) | npm workspaces monorepo | Accepted |
| [0008](0008-frontend-stack.md) | Circuit UI as the frontend foundation | Accepted |
