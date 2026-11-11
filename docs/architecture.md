# Architecture

An [Nx](https://nx.dev) monorepo on pnpm workspaces. Applications live in
`apps/`, shared code in `libs/`.

## Projects

| Project | Published as | Role |
|---|---|---|
| `apps/board` | `@lk/maggie-board` | Vue 3 kanban dashboard + zero-dependency server, and the `maggie` command (`maggie`, `maggie --board`, `maggie sync`, `maggie workspace`) |
| `apps/server` | `@lk/maggie-server` | `maggie-server` — the AI Factory agents server (`maggie --server`) |
| `libs/config` | `@lk/maggie-config` | load and validate the config, from a file or a git repo |
| `libs/git` | `@lk/maggie-git` | thin git/`gh` wrapper (clone, branch, commit, push, PR) |
| `libs/renderers` | `@lk/maggie-renderers` | per-target renderers (claude, copilot, cursor, windsurf) |
| `libs/skill-sync` | `@lk/maggie-skill-sync` | resolve skills for a repo and drive the sync pipeline |
| `libs/workspace-bootstrap` | `@lk/maggie-workspace-bootstrap` | clone/install, Claude Code & Copilot CLI hooks, board state model |
| `libs/ci-status` | `@lk/maggie-ci-status` | CI status payloads, validation, state mapping and folding |
| `libs/retro-doc` | `@lk/maggie-retro-doc` | read a repo's specs and plans, ask an LLM, write the retro-documentation |
| `.github/actions/ci-status-report` | private | composite action depositing CI status on the `ci-status` branch |

Everything published lives under the single `@lk` scope and is released in
lockstep on one version — see [Releasing](../CONTRIBUTING.md#releasing). The
repository root is private; the `maggie` command reaches users through the
`@lk/maggie-board` package's `bin` entries, which depends on `@lk/maggie-server`.

Each library exposes its public surface through its package entry
(`main` in its `package.json`). Nx enforces module boundaries by `scope:*` tags,
configured in `eslint.config.js`.

## Package manager

This repo builds and installs with **pnpm** (`pnpm install`, version pinned by
`packageManager` in `package.json`). Nx detects the package manager from the
lockfile, so `pnpm-lock.yaml` must remain the only lockfile — adding a
`package-lock.json` breaks the Nx project graph. `pnpm-workspace.yaml` lists the
workspaces, links `@lk/*` dependencies to the local packages
(`linkWorkspacePackages`) and allows the install scripts of `nx` and `node-pty`.

## The composite action's imports

`.github/actions/ci-status-report/report.js` imports `libs/ci-status` and
`libs/git` by **relative path**, not by package specifier. The GitHub Actions
runner checks out this repository and runs the script with no install step, so a
bare `@lk/…` import would resolve locally through the workspace symlink
and fail on the runner.

That constraint is asserted by a test
(`report.js imports the libs by relative path so the runner needs no npm install`)
and is why `@nx/enforce-module-boundaries` is switched off for that directory in
`eslint.config.js`.

## Testing

```bash
pnpm test            # nx run-many -t test — every project
pnpm run test:board  # apps/board only: server + reader (node:test) + front-end (vitest), 100% each
pnpm run lint
pnpm run build
```

Two testing styles coexist:

- **`node --test`** for libraries, the board server, the board's CI reader, and
  the composite action.
- **Vitest + `@vue/test-utils`** (jsdom) for the Vue front-end.

Nx caches test results aggressively. When verifying something for real, pass
`--skip-nx-cache` — an instant "pass" often means nothing ran.

### Coverage gates

Every project under `apps/`, `libs/` and `.github/actions/` enforces **100%
line, function and branch coverage**: through `node --test --experimental-test-coverage` wired in
its `project.json` (or the `nx` block of its `package.json`), and for the board's
Vue front-end through vitest's `coverage.thresholds` (statements too) in
`apps/board/vite.config.js`. A drop fails the build.

`scripts/check-coverage-gates.js` (`pnpm run check:coverage`) checks the gates
themselves: it fails when a project's `test` target no longer enforces 100%. CI
and the `pre-push` git hook (`.githooks/pre-push`, activated by `pnpm install`)
run it before the tests.

`.github/actions/ci-status-report` is tested by spawning its script as a
subprocess: `node --test` merges the coverage of child processes, so it is gated
like the rest.

A 100% gate proves every line ran, not that every contract is checked. Several
real defects in this codebase sat behind fully-covered lines — an argument
passed but never asserted, a `reset --hard` verified only by its arguments. Where
a guarantee matters, assert the guarantee.

### Conventions

Rationale belongs in `docs/superpowers/specs/`, not in comments. Invariants
belong in test names: a test called
`the reader never runs a git command that writes to the branch` fails when
someone breaks the rule, which a comment saying the same thing does not.

Commit format, the review bar and the release process are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## CI

`.github/workflows/ci.yml` runs `nx run-many -t lint test build` on pull
requests and pushes to `main`.

`.github/workflows/publish.yml` publishes to npm on release.
