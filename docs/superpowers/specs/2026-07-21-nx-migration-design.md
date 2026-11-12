# Nx Migration — Design

**Date:** 2026-07-21
**Status:** Approved (pending written-spec review)

## Purpose

This is sub-project 1 of a 3-part initiative:

1. **Nx migration of the repo (this spec)** — restructure `ai-sync` into an Nx
   workspace (`apps/*`, `libs/*`) with no functional or CLI-visible change.
2. **Verdaccio publish pipeline** (separate spec, later) — private npm registry +
   scripts to publish Nx libs.
3. **Status-hook lib** (separate spec, later) — a publishable lib that installs a
   Claude Code hook publishing progress into `~/.claude/projects/<project>/`
   instead of the current shared `board.json`, replacing `libs/workspace-bootstrap`'s
   `board.js`/`hooks.js`. The dashboard is adapted to read this new source via
   `repos.json`.

This spec covers **only** part 1: adopting Nx as the monorepo tool for the
existing codebase, as a clean foundation for parts 2 and 3. It intentionally
changes no behavior — every documented command in `README.md` keeps working
exactly as today.

## Decisions (locked during brainstorming)

- **Full migration**: all of `bin/sync.js`, `bin/workspace.js`, `src/**`, and
  `apps/board` move into the Nx workspace — not a partial/minimal adoption.
- **Package manager**: **npm** everywhere. `apps/board`'s separate pnpm
  sub-package (own `package.json` + `pnpm-lock.yaml`) is folded into the npm
  workspace at the root; the pnpm lockfile is removed.
- **Nx Cloud**: **not used**. No account, no remote cache, no data leaves the
  machine/CI runner. Only Nx's local cache (`.nx/cache`, gitignored).
- **Test coverage gate**: the current 100%-lines/functions/branches gate on
  `src/**` is **preserved, redistributed per lib** (each of the four libs below
  keeps its own 100% gate via its Nx `test` target).
- **`apps/board` tooling**: regenerated via the **`@nx/vue` generator** rather
  than hand-wiring Nx around the existing Vite/Tailwind/PostCSS config files.
  Accepted trade-off: this is the step most likely to touch working config, so
  it gets a manual browser check after migration, not just green tests.

## Target structure

```
apps/
  sync/         # CLI entry — today's bin/sync.js (skill sync across repos)
  workspace/     # CLI entry — today's bin/workspace.js (bootstrap + status tracking)
  board/         # Vue 3 + Tailwind dashboard, @nx/vue-generated; server.js unchanged
libs/
  git/                 # clone/exec git helpers — shared
  config/              # repos.json loading/validation — shared
  skill-sync/          # frontmatter, pipeline, skill(s), renderers/* — apps/sync only
  workspace-bootstrap/ # platform, installers, board, hooks, workspace logic — apps/workspace only
```

### Mapping from current files

| Current | New home |
|---|---|
| `src/git.js` | `libs/git` |
| `src/config.js` | `libs/config` |
| `src/frontmatter.js`, `src/pipeline.js`, `src/skill.js`, `src/skills.js`, `src/renderers/*` | `libs/skill-sync` |
| `src/platform.js`, `src/installers.js`, `src/board.js`, `src/hooks.js`, `src/workspace.js` | `libs/workspace-bootstrap` |
| `bin/sync.js` | `apps/sync` |
| `bin/workspace.js` | `apps/workspace` |
| `apps/board/**` (existing) | `apps/board` (regenerated shell, existing components/composables/`server.js` ported in) |
| `test/**` | colocated into each new lib/app, alongside its moved source |

`libs/workspace-bootstrap` is deliberately kept as its own bounded lib — it is
the exact area part 3 (status-hook) will later rework (`board.js`, `hooks.js`
replaced by the new per-project publishing mechanism), so this boundary is not
incidental.

### Module boundaries

Nx project tags enforce that `skill-sync` and `workspace-bootstrap` never import
from each other — only through the shared libs:

- `type:app` / `type:lib`
- `scope:sync` (`apps/sync`, `libs/skill-sync`)
- `scope:workspace` (`apps/workspace`, `libs/workspace-bootstrap`)
- `scope:board` (`apps/board`)
- `scope:shared` (`libs/git`, `libs/config`) — importable by any scope

Enforced via the `@nx/enforce-module-boundaries` ESLint rule.

## Behavior preservation

No functional changes. Concretely:

- `ai-sync` and `ai-workspace` binaries keep their exact current CLI surface
  (subcommands, flags, exit codes).
- Root `package.json` scripts (`lint`, `test`, `start`, `sync`, `wk`,
  `board:build`, `test:board`) keep working, now delegating to Nx targets
  (e.g. `"test": "nx run-many -t test"`).
- `README.md`'s documented commands and output require no edits.

## Testing

- Each lib (`git`, `config`, `skill-sync`, `workspace-bootstrap`) runs its
  existing `node --test` suite as an Nx `test` target, with the 100%
  lines/functions/branches gate preserved per lib.
- `apps/board` keeps vitest (Vue components) + `node --test` (`server.js`),
  wired as Nx targets by the `@nx/vue` generator.
- Existing test files move as-is (import paths updated); no test behavior is
  rewritten in this migration.

## CI

Single GitHub Actions job replaces the current two (`root` + `board`, which run
separate npm/pnpm installs):

1. One `actions/checkout` + one `actions/setup-node` (npm cache) + one `npm ci`.
2. `nx run-many -t lint test build` across all projects (or `nx affected` scoped
   to the PR's git diff, once the workspace is stable).

## Migration steps

1. `nx init` + install `nx`, `@nx/js`, `@nx/vue`, `@nx/eslint`; convert the root
   to an npm workspace (`apps/*`, `libs/*`).
2. Generate `libs/git`, `libs/config`, `libs/skill-sync`,
   `libs/workspace-bootstrap` (`@nx/js` generator); move source + tests; fix
   imports.
3. Generate `apps/sync` and `apps/workspace` as thin Node apps consuming the
   libs above; preserve the `bin` entries (`ai-sync`, `ai-workspace`).
4. Regenerate `apps/board` via `@nx/vue`; port existing components,
   composables, and `server.js`; reconcile Tailwind/PostCSS config against the
   generator's output.
5. Configure project tags and `@nx/enforce-module-boundaries`.
6. Rewrite `.github/workflows/ci.yml` to the single Nx-orchestrated job.
7. Once everything is green from the new locations: delete the old `src/`,
   `bin/`, `apps/board`'s standalone `package.json`/`pnpm-lock.yaml`, and the
   old root `eslint.config.js`.
8. Diff `README.md` against actual behavior; update only if something drifted.

**Highest-risk step**: step 4 (`@nx/vue` regeneration) touches the most
existing working configuration. It gets a manual smoke test in a browser
(`npm start`, verify the board renders and polls) in addition to the test
suite, per this project's own guidance on UI changes.

## Out of scope (YAGNI)

- Verdaccio / npm publishing setup — sub-project 2.
- The status-hook lib and any change to how/where board state is stored —
  sub-project 3. `libs/workspace-bootstrap` keeps today's `board.json` +
  shared-workspace behavior unchanged in this migration.
- Nx Cloud, distributed task execution, remote caching.
- Restructuring `wk/` (the live example workspace) or `repos.json`.
