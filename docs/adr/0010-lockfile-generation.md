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

## Update, 2026-09-03: repairing a lockfile that is already pruned

The rule above prevents the damage. It does not undo it, and the damage
recurred: the lockfile was regenerated with plain `npm install` on Windows while
Fastify was being added, and arrived on `main` with zero of the twelve
`@parcel/watcher` binaries. Docker found it before CI did, because `npm ci`
inside a Linux image fails on exactly the same error as the one quoted above.

Three things were measured while repairing it:

1. **`npm run lockfile` cannot repair a pruned lockfile.** With a lockfile
   present it builds the ideal tree from that lockfile and keeps its omissions —
   before and after were identical, 1169 entries and no platform binaries.
2. **Deleting the lockfile and regenerating on Windows crashes npm.**
   `Cannot read properties of null (reading 'edgesOut')`, thrown from
   arborist's `#loadPeerSet` while resolving `vitest`'s peers, on npm 11.5.2.
   With `node_modules` present instead, npm resolves from the installed tree and
   writes a lockfile with six `resolved` fields out of 1079 — worse than the one
   it replaced.
3. **Generating in a Linux container keeps every platform.** From manifests
   alone, no lockfile and no `node_modules`, `npm install --package-lock-only`
   on npm 11.19.0 produced 1219 entries with all twelve binaries — and 18 win32
   entries, 18 darwin, 64 linux.

Point 3 corrects the alternative rejected below. `--package-lock-only` resolves
the dependency graph without installing, so no platform filtering happens
whichever kernel it runs on; the objection applies to running a real
`npm install` in a container, not to this command. Verified after the fact by
`npm ci` on both sides: the Docker build and the Windows working copy.

So the repair path, when a pruned lockfile has already been committed, is to
regenerate it from the manifests in a container. Day-to-day dependency changes
still go through `npm run lockfile`, which is enough as long as the lockfile it
starts from is intact.

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

**Generate the lockfile inside a Linux container.** Rejected here on the grounds
that it makes every dependency change depend on Docker running, and that it
would strip *Windows* optional dependencies instead — the same problem pointed
the other way. The second half of that is wrong for `--package-lock-only`, and
the update above records the measurement. It remains the repair path rather than
the routine one, because of the first half.

**Commit no lockfile.** Removes the failure and removes reproducibility with it.
Not a real option for a project whose central claim is that results reproduce.

**Pin `npm` via `packageManager` and Corepack.** Worth doing on its own merits,
but it would not have prevented this: both npm 10 and npm 11 exhibit the
behaviour.
