# ADR-0010: The lockfile is generated with `--package-lock-only`

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

CI failed on every job with the same error:

```
npm error `npm ci` can only install packages when your package.json and
package-lock.json are in sync.
npm error Missing: @parcel/watcher-linux-x64-glibc@2.6.0 from lock file
npm error Missing: probe-image-size@7.4.0 from lock file
```

The cause is that **`npm install` run on Windows writes a lockfile that omits
optional dependencies for other platforms.** `npm ci` on Linux then refuses,
because the lockfile does not describe the tree it is being asked to build.

Measured rather than inferred. From a clean checkout:

| Command | Packages in lockfile | `@parcel/watcher-*` binaries |
|---|---|---|
| `npm install --package-lock-only` | 1170 | 12 |
| followed by plain `npm install` | 1120 | 0 |

Git history shows exactly when it broke: the lockfile carried all twelve
platform binaries at `d2b19e9` and none at `d085dee`. Between those two commits
the lockfile was deleted and regenerated with `npm install` on Windows, to work
around a missing native binding (npm/cli#4828). That workaround is what caused
this failure — one platform-specific npm bug was traded for another.

Reproduced in Docker under both Node 22 with npm 10 and Node 24 with npm 11, so
it is a platform difference, not an npm version difference.

## Decision

**Dependency changes go through `npm run lockfile`, and installation is always
`npm ci`.**

```jsonc
"lockfile": "npm install --package-lock-only --ignore-scripts"
```

- `--package-lock-only` resolves the full dependency graph without installing
  anything, so no platform filtering is applied and every optional variant is
  recorded.
- `npm ci` installs strictly from the lockfile and **never writes to it**, so it
  cannot strip entries the way `npm install` does.

Plain `npm install` is not to be used in this repository. It is the command that
silently makes the lockfile non-portable, and the damage is invisible until CI
runs on Linux.

The related engine mismatch is fixed at the same time: `.nvmrc` said `22` while
`@sumup-oss/foundry@10.1.0` requires `node >= 24`, which CI reported as
`EBADENGINE`. The Circuit UI template's own `.nvmrc` asks for `lts/krypton`,
which is Node 24 — the root file simply contradicted it. It now says `24`, and
`engines.node` matches.

## Consequences

- Adding or upgrading a dependency is two steps rather than one: edit the
  manifest (or let Dependabot do it), run `npm run lockfile`, then `npm ci`.
- CI is the backstop. `npm ci` fails loudly on a non-portable lockfile, which is
  precisely how this was found. That check is not decorative and must not be
  softened to `npm install` to make a red build go away.
- Dependabot opens PRs that update both `package.json` and `package-lock.json`.
  Those PRs run the same `npm ci`, so a lockfile it produces that is not
  portable fails in review rather than on `main`.
- This supersedes the throwaway line in
  [ADR-0007](0007-repository-structure.md) about "one `npm install`". The
  workspace layout is unchanged; only the command is.

## Alternatives considered

**Generate the lockfile inside a Linux container.** Correct and portable, but it
makes every dependency change depend on Docker running, and it would produce a
lockfile that strips *Windows* optional dependencies instead — the same problem
pointed the other way.

**Commit no lockfile.** Removes the failure and removes reproducibility with it.
Not a real option for a project whose central claim is that results reproduce.

**Pin `npm` via `packageManager` and Corepack.** Worth doing on its own merits,
but it would not have prevented this: both npm 10 and npm 11 exhibit the
behaviour.
