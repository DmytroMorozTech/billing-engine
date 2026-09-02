# Roadmap

Guiding rules for this project:

- **Depth over breadth.** Do three hard things properly rather than twelve things
  shallowly. The three: mid-cycle proration, money that always reconciles, and
  amounts that can be explained.
- **Do not start with the frontend.** The engine that calculates money correctly
  comes first. Effort split is roughly 75% backend, 25% frontend.
- **A finished modest project beats an unfinished ambitious one.** Stages 1 and 2
  reach a live deployment before anything gets polished.

---

## Stage 0 — Foundations

Small, but everything after it depends on these choices being right.

- [ ] npm workspaces skeleton per [ADR-0007](docs/adr/0007-repository-structure.md)
- [ ] `docker-compose.yml`: postgres, redis, api, worker, psp
- [ ] `packages/domain` with `Money` and `Clock`, no I/O
- [ ] ESLint rules that enforce the invariants rather than merely documenting them:
      no `Date` or `Temporal.Now` inside `packages/domain`; no `pg` / `ioredis` /
      `fastify` imports there either
- [ ] Vitest for backend, fast-check wired up
- [ ] `apps/web` scaffolded from the Circuit UI Next.js template, with the three fixes from
      [ADR-0008](docs/adr/0008-frontend-stack.md) applied
- [ ] CI: `npm ci`, lint, typecheck, test, `npm audit signatures`

**Done when:** `docker compose up` starts everything and CI is green on an empty
domain.

---

## Stage 1 — The engine

Without this there is no project. Note that this stage is **larger than originally
sketched**: because a plan buys a commission rate rather than a feature set
([ADR-0006](docs/adr/0006-plan-model-and-mid-cycle-rate-change.md)), transaction
ingestion and rating are core, not an add-on. Without them the pricing model does
not exist.

- [ ] Plan catalogue: Standard (€0 / 1.69%), Payments Plus (€19 / 0.99%)
- [ ] Merchants with a market and a billing time zone
- [ ] Subscriptions with an **anchor date**, correct anniversary handling
      (31 Jan → 28 Feb → **31 Mar**, not 28 Mar)
- [ ] Transaction ingestion and **rating per transaction** against the rate
      interval containing its `occurred_at`
- [ ] Rate intervals opened and closed by plan changes
- [ ] Billing period calculation in the merchant's time zone
- [ ] Invoice generation: prorated subscription fee + commission lines per rate
      segment
- [ ] **Derivation recorded at computation time** and stored with each line
      (format in [frontend-spec.md](docs/frontend-spec.md#5-the-derivation-format))
- [ ] Double-entry ledger; balance derived, never stored
- [ ] Virtual clock + deterministic scheduler ("advance one month" as a test
      primitive)

**Property tests for this stage:**

1. All ledger entries sum to zero after any random sequence of operations
2. Proration credits never exceed what was actually paid for the period
3. Recomputing a closed period produces a byte-identical invoice

**Done when:** a scripted scenario — create merchant, process transactions, change
plan mid-cycle, advance one month — produces a correct invoice, and the ledger
balances.

---

## Stage 2 — What sets it apart

- [ ] **Dunning:** payment fails → retries on a schedule → grace period →
      suspension. Driven by the PSP simulator's deterministic rejection rules.
- [ ] PSP simulator in Go (`apps/psp`), ~200–300 lines
- [ ] Idempotency on every write endpoint, Postgres-backed
      ([ADR-0004](docs/adr/0004-idempotency-in-postgres.md))
- [ ] Transactional outbox with a pluggable publisher
      ([ADR-0005](docs/adr/0005-outbox-with-pluggable-publisher.md))
- [ ] VAT by market: DE 19%, UK 20%, IT 22%; reverse charge for B2B with a valid
      VAT ID
- [ ] **Gapless invoice numbering** per legal entity, holding under concurrent
      writes and transaction rollbacks — a legal requirement in DE and IT
- [ ] Bitemporal plan changes: effective date vs recorded date, backdated changes
      producing credit notes
- [ ] OpenAPI generated from the Fastify JSON Schemas
- [ ] Errors as RFC 9457 Problem Details

**Property test:** invoice numbers are sequential per legal entity with no gaps,
under randomised concurrency and rollbacks.

**Done when:** the system is deployed live with seeded demo data and the full
dunning sequence can be watched end to end.

---

## Stage 3 — The showcase

Full specification in [docs/frontend-spec.md](docs/frontend-spec.md).

- [ ] Merchant portal: dashboard, subscription, **proration preview**, invoices,
      invoice detail, wallet, settings
- [ ] Support console: on-call dashboard, merchant search, merchant 360° with
      bitemporal timeline, **"why this amount"**, billing runs, stuck jobs
- [ ] Time machine bar, present in both portals in demo mode
- [ ] Shadow run v1 vs v2 with a money diff report — the v1 "legacy" calculator is
      the retroactive-repricing rule rejected in ADR-0006
- [ ] Reconciliation report (ledger invariants, numbering gaps)
- [ ] Invoice PDF with legally correct DE details
- [ ] `jest-axe` accessibility test on every screen

**Done when:** someone opening the deployed URL for the first time can press
"+1 month" and watch an invoice appear, a payment fail, and dunning start —
without reading any documentation first.

---

## Stage 4 — Around the code

Half the effect lives here.

- [ ] Live deployment (Fly.io / Railway + Neon) with seeded demo data
- [ ] README with the three key decisions and why they were made
- [ ] Three-minute video: create merchant → change plan mid-cycle → advance time →
      inspect invoice → "why this amount" → payment fails → dunning fires
- [ ] Clean commit history, no commits made through the GitHub web UI
- [ ] One deliberately found and fixed bug, written up with the test that catches
      it

### Candidate for that write-up

Three real bugs were already found in the Circuit UI Next.js template while
validating the stack — `npm run lint` and `npm run lint:css` both fail on a freshly
scaffolded project, one of them due to a Windows quoting bug. Recorded in
[ADR-0008](docs/adr/0008-frontend-stack.md). A domain bug found by the time machine
would be stronger still; if one appears, it takes this slot instead.

---

## Deliberately not doing

Kafka (an event bus is not the problem; delayed jobs are — see ADR-0005),
Kubernetes, volume-tiered rates, multi-currency wallets, and sign-up flows.

Nothing is added to this stack because it is fashionable or because it would look
impressive on a diagram. A Kafka cluster moving three messages a day is worse than
no Kafka at all: it is operational weight bought with no capability, and it makes
every other choice in the project harder to trust.
