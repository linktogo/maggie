# Architecture

An [Nx](https://nx.dev) monorepo on npm workspaces. Applications live in
`apps/`, shared code in `libs/`.

## Projects

| Project | Published as | Role |
|---|---|---|
| `apps/sync` | — (`@linktogo/maggie` bin) | `maggie` CLI — render skills into each repo and push |
| `apps/workspace` | — (`@linktogo/maggie` bin) | `maggie-workspace` CLI — bootstrap a workspace + status board |
| `apps/board` | private | Vue 3 kanban dashboard + zero-dependency server |
| `libs/config` | `@linktogo/maggie-config` | load and validate the config, from a file or a git repo |
| `libs/git` | `@linktogo/maggie-git` | thin git/`gh` wrapper (clone, branch, commit, push, PR) |
| `libs/renderers` | `@linktogo/maggie-renderers` | per-target renderers (claude, copilot, cursor, windsurf) |
| `libs/skill-sync` | `@linktogo/maggie-skill-sync` | resolve skills for a repo and drive the sync pipeline |
| `libs/workspace-bootstrap` | `@linktogo/maggie-workspace-bootstrap` | clone/install, Claude Code & Copilot CLI hooks, board state model |
| `libs/ci-status` | `@linktogo/maggie-ci-status` | CI status payloads, validation, state mapping and folding |
| `.github/actions/ci-status-report` | private | composite action depositing CI status on the `ci-status` branch |

Everything published lives under the single `@linktogo` scope and is released in
lockstep on one version — see [Releasing](../CONTRIBUTING.md#releasing). The
`apps/*` projects keep internal `@maggie/*` names and are never published on
their own; the CLIs reach users through the root `@linktogo/maggie` package's
`bin` entries.

Each library exposes its public surface through its package entry
(`main` in its `package.json`). Nx enforces module boundaries by `scope:*` tags,
configured in `eslint.config.js`.

## Package manager

This repo builds and installs with **npm** (`npm ci`). Nx detects the package
manager from the lockfile, so `package-lock.json` must remain the only lockfile
— adding a `pnpm-lock.yaml` breaks the Nx project graph.

## The composite action's imports

`.github/actions/ci-status-report/report.js` imports `libs/ci-status` and
`libs/git` by **relative path**, not by package specifier. The GitHub Actions
runner checks out this repository and runs the script with no install step, so a
bare `@linktogo/…` import would resolve locally through the workspace symlink
and fail on the runner.

That constraint is asserted by a test
(`report.js imports the libs by relative path so the runner needs no npm install`)
and is why `@nx/enforce-module-boundaries` is switched off for that directory in
`eslint.config.js`.

## Testing

```bash
npm test            # nx run-many -t test — every project
npm run test:board  # apps/board only: server + reader (node:test) + front-end (vitest)
npm run lint
npm run build
```

Two testing styles coexist:

- **`node --test`** for libraries, the board server, the board's CI reader, and
  the composite action.
- **Vitest + `@vue/test-utils`** (jsdom) for the Vue front-end.

Nx caches test results aggressively. When verifying something for real, pass
`--skip-nx-cache` — an instant "pass" often means nothing ran.

### Coverage gates

Every project under `libs/` enforces **100% line, function and branch coverage**
through `node --test --experimental-test-coverage`, wired in its `project.json`.
A drop fails the build.

Two projects deliberately have no percentage gate:

- `apps/board` — the Vue front-end and the HTTP server are covered by
  behavioural tests rather than a threshold.
- `.github/actions/ci-status-report` — an integration harness that spawns the
  script as a subprocess, so the parent process cannot measure its coverage.

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
