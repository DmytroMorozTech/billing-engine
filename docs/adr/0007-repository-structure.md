# ADR-0007: npm workspaces monorepo

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The system runs as five processes — API, worker, outbox publisher, a PSP
simulator in Go, and a Next.js frontend — but it is one product with one domain
model. Splitting it across repositories would mean versioning the shared domain
types through a registry for no benefit at this size.

There is also a concrete conflict to resolve. The frontend adopts the Circuit UI
toolchain wholesale (Foundry, Biome, ESLint, Stylelint, Jest, jest-axe — see
[ADR-0008](0008-frontend-stack.md)). The backend prefers Vitest. Two test runners
and two lint configurations in one flat package would fight each other.

## Decision

**A single repository using npm workspaces.**

```
billing-engine/
├── apps/
│   ├── api/          Fastify HTTP API           (entrypoint: dist/api.js)
│   ├── worker/       BullMQ consumers + outbox  (entrypoint: dist/worker.js)
│   ├── web/          Next.js — merchant portal + support console
│   └── psp/          payment provider simulator (Go)
├── packages/
│   ├── domain/       pure business logic: money, clock, rating, proration, ledger
│   ├── db/           schema, migrations, repositories
│   └── contracts/    JSON Schemas + generated types shared by api and web
├── docs/
│   ├── adr/
│   └── frontend-spec.md
├── docker-compose.yml
└── ROADMAP.md
```

Rules that make the structure mean something:

- **`packages/domain` has no I/O.** No database client, no HTTP, no `Date`, no
  `Temporal.Now`. It receives a `Clock` and returns values. This is what makes the
  time machine possible and the tests instant.
- **`packages/contracts` is the single source of truth for the API surface.**
  Fastify validates requests against those JSON Schemas; the frontend imports the
  types generated from the same schemas. A breaking API change fails to typecheck
  in `apps/web`.
- **Each app owns its own toolchain.** `apps/web` keeps the template's Foundry/Biome/Jest
  setup unchanged; everything else uses Vitest. Workspaces isolate them cleanly.
- **`apps/psp` is Go** and is not an npm workspace. It builds in its own Docker
  stage and is wired in through `docker-compose.yml`.

## Consequences

- One `npm install`, one lockfile, one place to run everything.
- Shared types cross the backend/frontend boundary without publishing anything.
- Two test runners live in the repo. This is intentional and documented here so it
  does not read as an accident.
- CI runs per-workspace jobs, so a frontend change does not rerun the domain
  property tests.
- `packages/domain` staying I/O-free must be enforced, not merely intended: an
  ESLint `no-restricted-imports` rule forbids importing `pg`, `ioredis`, `fastify`
  and friends from inside it.

## Alternatives considered

**Single flat package with multiple entrypoints.** Simplest to set up, and the
original sketch for this project. Rejected once the frontend brought its own
opinionated toolchain — the configs would have to be merged rather than isolated.

**Turborepo / Nx.** Real build-caching benefits at real scale. Here they add a
tool to explain and configure for a repository that builds in seconds.

**Separate repositories.** Realistic for a company with separate teams; pure
overhead for one author.
