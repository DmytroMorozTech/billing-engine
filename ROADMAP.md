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

- [x] npm workspaces skeleton per [ADR-0007](docs/adr/0007-repository-structure.md)
- [x] `docker-compose.yml`: postgres and redis
- [x] `docker-compose.yml`: api, worker, psp, plus a one-shot `migrate` service
      the other two wait on. Each arrived with its app rather than ahead of it —
      a compose file referencing a missing Dockerfile is worse than a short one
- [x] `packages/domain` with `Money` and `Clock`, no I/O
- [x] ESLint rules that enforce the invariants rather than merely documenting them:
      no `Date` or `Temporal.Now` inside `packages/domain`; no `pg` / `ioredis` /
      `fastify` imports there either. Verified against a probe file, not assumed.
- [x] Vitest for backend, fast-check wired up
- [x] `apps/web` scaffolded from the Circuit UI Next.js template, with the fixes from
      [ADR-0008](docs/adr/0008-frontend-stack.md) applied
- [x] CI: `npm ci`, lint, typecheck, test, `npm audit signatures`

**Done when:** `docker compose up` starts everything and CI is green on an empty
domain.

---

## Stage 1 — The engine

Without this there is no project. Note that this stage is **larger than originally
sketched**: because a plan buys a commission rate rather than a feature set
([ADR-0006](docs/adr/0006-plan-model-and-mid-cycle-rate-change.md)), transaction
ingestion and rating are core, not an add-on. Without them the pricing model does
not exist.

- [x] Plan catalogue: Standard (€0 / 1.69%), Payments Plus (€19 / 0.99%)
- [x] Merchants with a market and a billing time zone
- [x] Subscriptions with an **anchor date**, correct anniversary handling
      (31 Jan → 28 Feb → **31 Mar**, not 28 Mar)
- [x] Transaction ingestion and **rating per transaction** against the rate
      interval containing its `occurred_at`
- [x] Rate intervals opened and closed by plan changes, prospectively and
      backdated
- [x] Billing period calculation in the merchant's time zone
- [x] Invoice generation: prorated subscription fee + commission lines per rate
      segment
- [x] **Derivation recorded at computation time** and stored with each line
      (format in [frontend-spec.md](docs/frontend-spec.md#5-the-derivation-format))
- [x] Double-entry ledger; balance derived, never stored
- [x] Virtual clock + deterministic scheduler ("advance one month" as a test
      primitive)

**Property tests for this stage:**

1. [x] All ledger entries sum to zero after any random sequence of operations —
       run against PostgreSQL, since that is where the invariant is enforced
2. [x] The prorated subscription fee never exceeds the full fee, wherever in the
       cycle the plan changes
3. [x] Recomputing a closed period produces a byte-identical invoice
4. [x] A plan change always leaves a timeline that tiles — no gap to leave a
       period unpriced, no overlap to price a transaction twice

The original wording of (2) promised that *proration credits* never exceed what
was paid. Credits require credit notes, which require the backdated-correction
machinery, and that belongs to Stage 2 — see below. The invariant asserted here
is the part that exists.

**Done when:** a scripted scenario — create merchant, process transactions, change
plan mid-cycle, advance one month — produces a correct invoice, and the ledger
balances.

---

## Stage 2 — What sets it apart

- [x] **Dunning:** payment fails → retries on a schedule → grace period →
      suspension. Driven by the PSP simulator's deterministic rejection rules.
      Four attempts on days 0, 1, 3 and 7 from issue. A merchant who pays on the
      third is active again; one who never pays is suspended and the invoice
      becomes uncollectible — not forgiven, so the debt stays on the ledger.
      The schedule is a pure function, so the sequence runs in a test in
      milliseconds rather than a week.
- [x] PSP simulator in Go (`apps/psp`), ~250 lines. Stateless: the charge id is
      derived from the idempotency key and the outcome from the amount and the
      attempt number, so a restarted container answers a demo identically. `…01`
      never has the money, `…02` clears on the third attempt, `…03` is an expired
      card, `…99` takes five seconds — something for the stuck-jobs screen.
- [x] Idempotency on every write endpoint, Postgres-backed
      ([ADR-0004](docs/adr/0004-idempotency-in-postgres.md)). The key row commits
      in the same transaction as the effect it protects, and the scope includes
      the merchant id — two merchants can legitimately send an identical payload.
- [x] Transactional outbox with a pluggable publisher
      ([ADR-0005](docs/adr/0005-outbox-with-pluggable-publisher.md)).
      `finaliseInvoice` announces the invoice in the transaction that issued it;
      `apps/worker` relays with `FOR UPDATE SKIP LOCKED` into BullMQ. Consumers
      arrive with dunning — a worker running an empty handler registry would be
      code with nothing to do.
- [x] VAT by market: DE 19%, UK 20%, IT 22%; reverse charge for B2B with a valid
      VAT ID. Three treatments rather than two: the UK is outside the EU, so a
      British business is an out-of-scope supply, not a reverse charge — both
      come to zero and they cite different law. The treatment is stored on the
      invoice, because "why is there no VAT here" is a question with two
      possible answers.
- [x] **Gapless invoice numbering** per legal entity, holding under concurrent
      writes and transaction rollbacks — a legal requirement in DE and IT.
      `finaliseInvoice` takes a `Transaction`, so a number cannot be issued
      outside the transaction that keeps it.
- [x] **Credit notes for backdated changes.** Moved here from Stage 1. Moving
      an upgrade from 15 September back to the 5th changes the same invoice from
      14071 to 11385, and the 2686 difference now leaves as `DE-CN-2026-000001`
      with its own gapless series and a reversing ledger transfer. Correcting a
      period twice measures against what is still charged, so the same money is
      never returned twice. A change that makes a period *dearer* is refused
      rather than issued as a negative credit note: that is a supplementary
      invoice, a different document in law.
- [x] Property test that a proration credit never exceeds what was actually paid
      for the period — generated over where the upgrade fell and where it is
      moved to, since that pair is what a support engineer actually edits
- [ ] OpenAPI generated from the Fastify JSON Schemas
- [x] Errors as RFC 9457 Problem Details, including the failures Fastify raises
      itself — a client never has to tell our error shape from the framework's

**Property test:** [x] invoice numbers are sequential per legal entity with no
gaps, under randomised concurrency and rollbacks. Mutation-checked: removing the
row lock makes it fail, so it is testing the lock rather than the happy path.

**Done when:** the system is deployed live with seeded demo data and the full
dunning sequence can be watched end to end.

The seed exists: `apps/worker` fills an empty database with six merchants —
the worked example, reverse charge, an out-of-scope supply, one merchant
suspended after four failed attempts, one recovered on the third, and one
corrected by a credit note. It builds them by running the system rather than
by writing rows, so it cannot produce a state the real path could not reach.
Deployment is the remaining half, and by decision it stays last (Stage 4).

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
