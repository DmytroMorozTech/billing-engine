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

> **Amended 2026-09-04.** That sentence was true of the machine it was written
> on and not of a fresh clone. Two further Windows-only faults were found when
> the first real screen was built; both are recorded under "Windows" below.
> Neither is caused by the toolchain being separate from the backend's — one is
> an npm bug and the other a line-ending setting — so the decision stands, but
> "verified working" was too strong a claim to make from a single machine.

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

A freshly scaffolded template does not survive its own scripts. Five fixes are
applied in `apps/web` and are **not** upstreamed for now:

| File | Problem | Fix |
|---|---|---|
| `package.json` | stylelint pattern wrapped in single quotes — `cmd.exe` does not strip them, stylelint receives a literal pattern, finds no files, exits 1 | wrap the pattern in double quotes |
| `package.json` | `test:ci` starts with `mkdir -p __reports__`. `cmd.exe` has no `-p` flag, so it creates a stray directory named `-p` and then fails on the second run because `__reports__` already exists | `node -e "require('node:fs').mkdirSync('__reports__',{recursive:true})"` — cross-platform and adds no dependency |
| `biome.jsonc` | Biome formats `next-env.d.ts`, a Next.js-generated file marked do-not-edit, and lints the Jest coverage report | add `files.includes` with `!next-env.d.ts`, `!.next/**`, `!__coverage__/**`, `!__reports__/**` — and **no** catch-all entry, since Foundry's shared config already provides one (`lint/suspicious/noBiomeFirstException`) |
| `.stylelintignore` (new) | stylelint lints `__coverage__/base.css`, part of Istanbul's HTML report, and reports ~500 violations in third-party CSS | ignore `.next/`, `__coverage__/`, `__reports__/` |
| `components/DocCard/DocCard.tsx` | `target="_blank"` without `rel`, violating Foundry's own `lint/security/noBlankTarget` | add `rel="noopener"` |

The coverage-directory problems share one root cause worth naming: Jest is
configured to write to `__coverage__`, but the template's `.gitignore` excludes
`/coverage`. So its own test output is neither ignored by git nor by either
linter. Running `npm run test:ci` followed by `npm run lint` on an untouched
scaffold fails — which is the ordering any CI pipeline uses.
`apps/web/.gitignore` is corrected to match the directories Jest actually
produces.

### Windows

Two faults that appear only on Windows, found on 2026-09-04 when the first
screen was built against the API. Both are local-development faults: CI runs on
Linux and was green throughout.

**Biome rejects CRLF, and the repository checked files out as CRLF.**
`.gitattributes` said `* text=auto`, which means LF in the repository and
native endings in the working tree — so on Windows every source file arrived
with CRLF and `biome check` failed on it. Measured rather than assumed: deleting
`apps/web/app/page.tsx` and checking it out again produced 57 CRLF pairs and a
formatter error. A fresh clone therefore could not pass
`npm run lint --workspace @billing/web`.

Fixed by `* text=auto eol=lf`, which is what the file already did for `*.sh`,
`*.yml` and `Dockerfile` under the heading "files that must keep LF even on
Windows checkouts". Biome is one more such case. Thirteen tracked files were
normalised on disk; none changed content, because the repository already stored
them as LF.

**`npm ci` does not install an optional peer dependency's native binding.**
Foundry's ESLint config imports `eslint-import-resolver-oxc` at module load,
which loads `oxc-resolver`, which needs a platform binary. All nineteen
platform bindings are in the lockfile and none were installed, so importing the
config threw `Cannot find native binding` before any rule ran. The distinguishing
feature is that npm had resolved them as `optional` **and** `peer`; the win32
binaries for `@next/swc`, `@biomejs/cli` and `lightningcss` all installed
normally.

npm's own advice — delete `package-lock.json` and `node_modules`, run
`npm i` — is precisely what [ADR-0010](0010-lockfile-generation.md) forbids, and
is what produced a non-portable lockfile twice. It was not followed.

Fixed by declaring the binding directly in `apps/web/package.json`:

```jsonc
"optionalDependencies": {
  "@oxc-resolver/binding-win32-x64-msvc": "11.24.2"
}
```

A plain optional dependency is installed normally — the bug affects the optional
*peer* case — and the package declares `"os": ["win32"]`, so npm skips it on
Linux and macOS and CI is unaffected. The lockfile entry loses its `peer` flag
and keeps `os: ["win32"]`, which is the whole fix. It is a workaround for
[npm/cli#4828](https://github.com/npm/cli/issues/4828) and should be removed if
npm or Foundry resolves it upstream.

A `postinstall` script was considered and rejected: this project pins workflow
actions by SHA and generates its lockfile with `--ignore-scripts`, and a script
that reaches the network during install runs against that. A documented manual
step was rejected because it has to be repeated after every `npm ci`.

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

The same standard is applied to the pipeline itself, since a workflow is a
dependency that runs with repository credentials:

- Workflow actions are pinned to **commit SHAs**, not tags. A tag is mutable and
  its author can repoint it at any time; a SHA cannot be moved. Dependabot keeps
  the pins current, because a stale pin is worse than an honest tag.
- The workflow declares `permissions: contents: read`. Without it the jobs
  inherit the repository default, which is frequently write-capable — a token
  that can push, handed to a job that only runs a linter.
- Runners are pinned to `ubuntu-24.04` rather than `ubuntu-latest`. That label
  currently resolves to the same image, but it moves on GitHub's schedule, and a
  project whose whole claim is reproducible calculation should not have a CI
  environment that changes underneath it.

## Alternatives considered

**Tailwind / shadcn.** Faster to start with for a generic product, but every
billing-shaped component would have to be built: `CurrencyInput`,
`PercentageInput`, `Numeral`, `Timestamp`, `ComparisonTable`, `TierIndicator` all
exist here already, and each one is a place where money or dates could be
formatted wrongly.

**Circuit UI components with a hand-rolled toolchain.** Avoids husky@4 and the
advisory, but loses `jest-axe` and the shared lint rules — and then the linting
setup becomes another thing to design and maintain instead of a solved problem.
