## What it does

This domain defines the repository-wide move to an Nx-managed npm workspace: where applications and libraries live, which projects may depend on one another, and how local commands and CI invoke project tasks. Its implementation surface is the root workspace and Nx configuration, the `apps/` and `libs/` projects, ESLint boundary rules, and `.github/workflows/ci.yml`.

The migration is intended to reorganize the repository without changing existing behavior or CLI interfaces. The design and plan describe the intended structure; they do not establish that the migration was completed.

## Architecture as designed

- The root npm workspace owns the repository packages and the single lockfile. It absorbs the board's former separate pnpm package.
- Nx orchestrates three applications: `apps/sync` and `apps/workspace` for the existing CLI entry points, and `apps/board` for the Vue board.
- Five plain-ESM libraries provide shared and domain logic: `libs/git`, `libs/renderers`, `libs/config`, `libs/skill-sync`, and `libs/workspace-bootstrap`. The implementation plan extracts `renderers` as a separate library so `config` can import the renderer registry's `knownTargets` without crossing the sync/workspace boundary.
- Projects use npm workspace bare-specifier imports such as `@ai-sync/<lib>`. Nx project tags and `@nx/enforce-module-boundaries` constrain dependencies: `scope:sync`, `scope:workspace`, and `scope:board` projects may use only their permitted domain and `scope:shared` dependencies. Sync and workspace remain isolated; the board remains standalone.
- `libs/workspace-bootstrap` contains reusable bootstrap logic. CLI argument parsing and status routing belong in `apps/workspace`; the app computes `hookCommand` because its path is app-specific.
- `apps/board` is regenerated with `@nx/vue`, then existing board code and configuration are ported. Existing Tailwind and PostCSS configuration is carried over directly, and the generated HTML entry must reference `main.js`.
- CI runs lint, tests, and build through one Nx-orchestrated job and one npm install. There is no Nx Cloud or remote cache.
- Coverage remains at 100% for lines, functions, and branches. The design assigns the gate to each library's test target; the implementation plan says to preserve the existing per-project gate but does not further specify its target coverage configuration.

## Decision log

| Decision | Rationale | Where it lives | Source |
|---|---|---|---|
| Separate `renderers` into a fifth shared library rather than keeping it inside `skill-sync`. | `config` imports `knownTargets` from the renderer registry; this placement avoids a forbidden boundary dependency. | `libs/renderers`, `libs/config`, Nx tags and ESLint boundary rules | [Implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Use five hand-authored plain-ESM libraries and two hand-authored CLI apps; generate the Vue board app with `@nx/vue`. | The `@nx/js:library` generator adds unwanted TypeScript tooling, while the Vue generator has specific defects that require correction. | `libs/*`, `apps/*`, root Nx configuration | [Implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Use npm workspace bare-specifier imports and enforce project boundaries with tags and ESLint. | Explicit cross-library dependencies can be checked, and sync and workspace scopes stay isolated. | Root npm workspace, Nx project tags, root `eslint.config.js` | [Implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Keep CLI parsing and status routing in `apps/workspace`; keep `libs/workspace-bootstrap` reusable. | The previous `workspace.js` mixed library logic with CLI-only behavior; `hookCommand` must be based on the app's location. | `apps/workspace`, `libs/workspace-bootstrap` | [Implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Run CI lint, test, and build through one Nx job and one npm install. | This replaces the separate root and board jobs and their npm/pnpm installs. | `.github/workflows/ci.yml` | [Implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Preserve existing commands and behavior while moving the repository into `apps/*` and `libs/*`. | The migration is a workspace foundation, not a change to the CLI contract or documented workflows. | Root `package.json`, project targets, README commands | [Design](../../superpowers/specs/2026-07-21-nx-migration-design.md); [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |
| Use npm workspaces throughout, folding the board package into the root workspace. | This removes the separate package manager and lockfile. | Root `package.json` and lockfile; `apps/board/package.json` | [Design](../../superpowers/specs/2026-07-21-nx-migration-design.md) |
| Keep Nx local-only: do not enable Nx Cloud or remote caching. | No account, remote cache, or data leaving the machine or CI runner is wanted. | Root Nx configuration and CI workflow | [Design](../../superpowers/specs/2026-07-21-nx-migration-design.md) |
| Retain 100% line, function, and branch coverage, redistributed across library test targets. | The existing coverage gate remains in force as project boundaries change. | Library test targets and CI | [Design](../../superpowers/specs/2026-07-21-nx-migration-design.md); [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md) |

## Invariants

1. Preserve the `ai-sync` and `ai-workspace` CLI surfaces, including subcommands, flags, and exit codes. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md).
2. Keep the root `lint`, `test`, `start`, `sync`, `wk`, `board:build`, and `test:board` scripts working, delegating to Nx targets. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md).
3. Keep 100% line, function, and branch coverage for each library's test target. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md); [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md).
4. Keep `scope:sync` and `scope:workspace` from depending on one another; use `scope:shared` for common dependencies, and keep the board standalone. Source: [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md).
5. Keep `libs/workspace-bootstrap` as a bounded library; do not fold CLI argument parsing or status routing back into it. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md); [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md).
6. Preserve the board server's expected build output at `apps/board/dist`, and ensure the generated HTML points to `main.js` so `nx run board:build` can succeed. Source: [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md).
7. Keep board styling configuration by porting the existing Tailwind and PostCSS configuration rather than relying on an unavailable `@nx/vue@23.1.0` Tailwind setup generator. Source: [implementation plan](../../superpowers/plans/2026-07-21-nx-migration.md).
8. Do not add Nx Cloud or remote caching. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md).
9. Do not change board-state storage, `wk/`, or `repos.json` as part of this migration. Source: [design](../../superpowers/specs/2026-07-21-nx-migration-design.md).

## Drift and superseded decisions

This is the risky part of the document: the architecture is a plan, not confirmed evidence of the current repository. Check the actual workspace manifests, Nx project configuration, tags, and CI workflow before relying on these paths or boundaries. The implementation plan's task checkboxes are unchecked; its report that generator commands were tried in a throwaway sandbox verifies generator behavior, not completion of the migration.

The design proposed four libraries: `git`, `config`, `skill-sync`, and `workspace-bootstrap`. The later implementation plan refines that layout to five by extracting `libs/renderers` as shared code. Treat the five-library layout as the current recorded design and the four-library mapping as superseded.

The design describes regenerating `apps/board` with `@nx/vue` at a higher level. The later plan records concrete generator defects and required corrections: hand-author the plain-ESM libraries, port Tailwind/PostCSS directly, and fix the HTML entry from `main.ts` to `main.js`. These implementation details qualify the design rather than overturning its overall migration direction.

## Open questions

- The supplied record does not say whether the migration was ultimately implemented or whether the present repository still matches this target structure. Before changing project wiring, verify it against the checked-in manifests, Nx configuration, ESLint rules, and CI workflow.
- The record does not give the final contents of the root scripts or Nx target definitions; it establishes only the command names and that they must continue to work.
- The record does not document any later changes to the project-tag vocabulary, permitted dependency matrix, npm package names, or CI job details. Ask a maintainer before changing those conventions if the current configuration does not resolve the intended boundary.
- The design record says nothing about this.
