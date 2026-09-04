# billing-engine

A billing and subscriptions engine for a small-business payments platform:
subscription plans, mid-cycle changes, per-transaction commission, and a
double-entry merchant wallet.

Built as a study of the parts of billing that are easy to get wrong.

---

## The pricing model

A merchant pays a monthly subscription **and** a percentage of every transaction —
and the subscription is what buys the lower percentage:

| Plan | Monthly fee | In-person rate |
|---|---|---|
| Standard | €0 | 1.69% |
| Payments Plus | €19 | 0.99% |

That hybrid is what makes the domain interesting. A merchant who upgrades on the
15th has already processed volume at the old rate, so a single invoice line splits
into two rate segments with different day counts, while the monthly fee is
prorated across the same boundary. There is no obvious right answer, which is
exactly why it is worth building.

## Three decisions worth arguing about

**Money is an integer in minor units, and rounding happens per line.**
`1999` + `EUR`, never `19.99`, never a float, anywhere — not in the domain, not in
the database, not on the wire. Rounding three items of `10.005` per line gives
`30.03`; summing first gives `30.02`. Both are defensible, only one can be
implemented, and there is a test that asserts the two orders differ so the choice
stays visible. → [ADR-0001](docs/adr/0001-money-as-integer-minor-units.md)

**Time is an injected dependency, and dates use Temporal.**
`new Date()` does not appear in the domain once — a lint rule enforces it. A
virtual clock plus a deterministic scheduler makes "advance one month" a test
primitive, so eleven renewals take milliseconds instead of eleven months. The date
arithmetic itself runs on `Temporal`, because the anniversary problem
(31 Jan → 28 Feb → **31 Mar**, not 28 Mar), DST-length days, and per-merchant time
zones are where the real bugs live.
→ [ADR-0002](docs/adr/0002-injectable-clock-and-temporal.md)

**Idempotency keys live in PostgreSQL, in the same transaction as the effect.**
Redis with a TTL is the tempting version and it is wrong: the two writes cannot be
atomic, so a crash between them either charges a merchant twice or never charges
them at all. The key and the payment commit together or not at all, and a replay
returns the *original response*, not a conflict.
→ [ADR-0004](docs/adr/0004-idempotency-in-postgres.md)

## Invariants, checked by property-based tests

Asserted over randomly generated sequences of events, not hand-picked examples:

1. Every ledger entry sums to zero across the system — balances are derived, never
   stored
2. Invoice numbers are sequential per legal entity with **no gaps**, under
   concurrent writes and rollbacks (a legal requirement in DE and IT)
3. Proration credits never exceed what was actually paid for the period
4. Recomputing a closed period produces a byte-identical invoice

## Stack

**TypeScript / Node.js (Fastify) · PostgreSQL · Redis · BullMQ · Next.js with
Circuit UI · Docker**, plus a small payment-provider simulator in **Go**.

Each choice is argued in [docs/adr/](docs/adr/), including the ones that are
deliberate omissions — most notably [why there is no Kafka](docs/adr/0005-outbox-with-pluggable-publisher.md)
despite the transactional outbox pattern being used.

The frontend is built on Circuit UI, an Apache-2.0 design system published as
`@sumup-oss/circuit-ui`, starting from its Next.js template and keeping that
toolchain unchanged — including `jest-axe`, which makes an accessibility test
part of the definition of done for every screen. The reasoning is in
[ADR-0008](docs/adr/0008-frontend-stack.md).

## Documentation

- [ROADMAP.md](ROADMAP.md) — stages, and what is deliberately not being built
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/frontend-spec.md](docs/frontend-spec.md) — screens, URLs, and the
  derivation format that makes "why is this amount" possible

## Status

Early. See the roadmap for what exists and what does not.
