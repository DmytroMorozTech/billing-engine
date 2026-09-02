# ADR-0008: Circuit UI as the frontend foundation

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

The frontend is roughly 25% of this project's effort, and its job is to make the
billing engine legible — not to demonstrate CSS. Building a component library from
scratch would consume the budget for the screens that actually matter.

SumUp maintains an open-source design system, `@sumup-oss/circuit-ui`
(Apache-2.0), and ships an official `create-next-app` template carrying their full
frontend toolchain.

## Decision

**Build on Circuit UI, starting from its official Next.js template, and adopt
its toolchain wholesale.**

Verified by scaffolding the template and running it (2026-09-02, Node 24.18.0):

| | |
|---|---|
| next | 16.3.4 (App Router, Turbopack) |
| react / react-dom | 19.2.8 |
| typescript | 6.0.3 |
| @sumup-oss/circuit-ui | 11.20.0 |
| @sumup-oss/design-tokens | 10.2.0 |
| @sumup-oss/foundry | 10.1.0 |
| jest / jest-axe | 30.5.1 / 10.0.0 |
| temporal-polyfill | 1.0.4 |

`npm run build`, `npx jest --ci`, `npm run lint` and `npm run lint:css` all pass
after the fixes recorded below.

Consequences worth naming explicitly:

- Circuit UI dropped Emotion for CSS Modules in v7, so React Server Components
  work without workarounds. The template is already App Router.
- The template ships `jest-axe`. **Accessibility tests are therefore part of the
  definition of done for every screen**, not an afterthought.
- `temporal-polyfill` is already a dependency, which aligns the frontend with
  [ADR-0002](0002-injectable-clock-and-temporal.md).
- `@sumup-oss/intl` handles locale-aware money and date formatting, which the
  three-market requirement (DE/UK/IT) needs anyway.

### Accepted debt

Adopting the toolchain wholesale means inheriting its current state:

- `@sumup-oss/foundry@10.1.0` depends on **`husky@4.3.8`** (January 2021). Current
  husky is v9 with a different config format. Not upgraded, because partially
  replacing Foundry's dependencies negates the reason for using it.
- `npm audit` reports one advisory, **GHSA-ggr8-5vv4** (stack exhaustion in
  `deepmerge-ts`), reached through Foundry. Foundry is a dev dependency and never
  enters the production bundle; practical risk is nil.

### Local fixes to the template

A freshly scaffolded template fails its own lint on Windows. Three fixes are
applied in `apps/web` and are **not** upstreamed for now:

| File | Problem | Fix |
|---|---|---|
| `package.json` | stylelint pattern wrapped in single quotes — `cmd.exe` does not strip them, stylelint receives a literal pattern, finds no files, exits 1 | wrap the pattern in double quotes |
| `biome.jsonc` | Biome formats `next-env.d.ts`, a Next.js-generated file marked do-not-edit | add `files.includes` with `!next-env.d.ts` and `!.next/**` — and **no** catch-all entry, since Foundry's shared config already provides one (`lint/suspicious/noBiomeFirstException`) |
| `components/DocCard/DocCard.tsx` | `target="_blank"` without `rel`, violating Foundry's own `lint/security/noBlankTarget` | add `rel="noopener"` |

### Supply-chain verification

Performed before committing to the stack, recorded here so it is not repeated from
memory:

- `@sumup-oss/circuit-ui@11.20.0` carries a **SLSA provenance attestation**: built
  by GitHub Actions from `github.com/sumup-oss/circuit-ui`, `refs/heads/main`,
  `.github/workflows/ci.yml`, on a GitHub-hosted runner. The published artifact is
  cryptographically tied to the public source, so a registry-side swap is not
  possible without breaking the signature.
- `npm audit signatures`: **1080 of 1080 packages verified**, 247 with
  attestations.
- Only three packages in the tree run `install`/`postinstall` scripts
  (`@parcel/watcher`, `unrs-resolver`, `husky@4`). Each was inspected and each was
  a no-op on this platform. Note that `prepare` scripts — which appear in ~90
  packages — do not run for dependencies installed from the registry.
- No `eval`, `new Function`, `child_process` or obfuscation in any `@sumup-oss/*`
  package. Circuit UI's runtime contains **no network calls at all**: no fetch, no
  beacon, no telemetry.
- Next.js' own anonymous telemetry is disabled (`npx next telemetry disable`).

This is provenance verification, not proof that no malware exists. It does not
cover a hypothetical compromise of an upstream maintainer, and it is a snapshot in
time. Mitigation: the lockfile is committed, and CI runs `npm ci` plus
`npm audit signatures` so drift is caught.

## Alternatives considered

**Tailwind / shadcn.** Faster to start with for a generic product, but every
billing-shaped component would have to be built: `CurrencyInput`,
`PercentageInput`, `Numeral`, `Timestamp`, `ComparisonTable`, `TierIndicator` all
exist here already, and each one is a place where money or dates could be
formatted wrongly.

**Circuit UI components with a hand-rolled toolchain.** Avoids husky@4 and the
advisory, but loses `jest-axe` and the shared lint rules — and then the linting
setup becomes another thing to design and maintain instead of a solved problem.
