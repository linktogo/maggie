# Contributing to maggie

Thanks for taking the time to contribute. This document covers how to get the
project running locally, what the test bar is, and how changes get merged.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

Requirements: **Node.js >= 24.22.1** and **pnpm** (see below — pnpm is not optional here).
The pinned version is in `package.json` (`packageManager`): `corepack enable`
installs it.

```bash
git clone https://github.com/linktogo/maggie.git
cd maggie
pnpm install
pnpm test
```

The repo is an [Nx](https://nx.dev) monorepo using pnpm workspaces (`pnpm-workspace.yaml`): applications
in `apps/`, shared libraries in `libs/`, the skills library in `skills/`. See
[Project layout](README.md#project-layout) for what each project does.

> **Keep `pnpm-lock.yaml` as the only lockfile.** Nx detects the package
> manager from the lockfile; adding a `package-lock.json` or `yarn.lock` breaks
> the project graph and the CI build. Install with pnpm only: Nx reads
> `node_modules/.modules.yaml`, which npm does not write.

> **`node-pty` is native.** The Factory console's pseudo-terminal
> (`libs/agent-runner`, optional dependency) ships prebuilt binaries for macOS
> and Windows; on Linux `pnpm install` compiles it with node-gyp (Python 3 and a C++
> toolchain). If that build fails the install still succeeds and the console is
> reported unavailable.

## Running things locally

```bash
pnpm test            # nx run-many -t test — every lib/app, 100% coverage gate each
pnpm run test:board  # apps/board only: server (node:test) + front-end (vitest), both at 100%
pnpm run check:coverage # fails if any project no longer enforces a 100% gate
pnpm run lint        # nx run-many -t lint
pnpm run build       # nx run-many -t build
pnpm start           # build + serve the kanban dashboard
```

`pnpm run server -- --repos repos.example.json` starts the AI Factory agents
server (see [AI Factory](docs/ai-factory.md)); it needs the `claude` or
`copilot` CLI to actually run an agent, tests never do.

`pnpm run retro-doc` reconstructs a repository's design record into one
agent-facing document, asking which repository of the workspace to document and
which LLM to use (Anthropic API, the `claude` CLI or the `copilot` CLI). Add
`--dry-run` to see what it would read and cost without calling anything. See
[Retro-documentation](docs/retro-doc.md).

The screenshots in `docs/images` are generated, not captured by hand:

```bash
pnpm run board:build
NODE_PATH="$(npm root -g)" node docs/screenshots/capture.mjs
```

`docs/screenshots/capture.mjs` serves the built board with a stub API and its
own demo data — one scene per image — so a UI change can be reflected in the
docs by rebuilding and re-running it. It needs Playwright and a Chromium
(`npm i -g playwright && playwright install chromium`); it is deliberately not
a project dependency, since nothing in CI runs it.

To exercise the CLIs against the sample config without touching any real repo:

```bash
node apps/board/bin/maggie.js sync --config repos.example.json --dry-run
node apps/board/bin/maggie.js workspace --config repos.example.json --workspace /tmp/ws --dry-run
```

## Tests and the coverage gate

Every project under `apps/`, `libs/` and `.github/actions/` — the board included — enforces a **100%
coverage gate** on lines, functions and branches (and statements for vitest). A
patch that lowers coverage fails CI, so new code needs new tests.

Two checks hold the line, both run by CI and by a **`pre-push` git hook**:

- `pnpm run check:coverage` (`scripts/check-coverage-gates.js`) fails if any
  project's `test` target stops enforcing 100%: a `node --test` command without
  `--experimental-test-coverage` or with a threshold below 100, a vitest config
  without `coverage.enabled` and 100% thresholds, or a project with no gated
  runner at all.
- `pnpm exec nx run-many -t test` runs every project's tests under that gate (Nx
  caches the projects you did not touch).

`pnpm install` activates the hook (the root `prepare` script points
`core.hooksPath` at `.githooks/`). `git push --no-verify` skips it locally, but
CI runs the same checks.

This project is developed test-first: write the failing test, make it pass, then
refactor. If a change is genuinely untestable, say so in the pull request rather
than lowering the threshold.

Tests live next to the code they cover:

- `libs/*/test/*.test.js` and `apps/server/test/*.test.js` — `node:test`
- `apps/board/cli/maggie.test.js` and `apps/board/cli/{sync,workspace}/test/*.test.js` — `node:test` for the `maggie` command and its `sync` / `workspace` subcommands
- `apps/board/*.test.js` — `node:test` for the server side (`server.js`, `ciReader.js`, …), all run together so their coverage adds up
- `apps/board/src/*.test.js` — `vitest` + `@vue/test-utils`, coverage via `@vitest/coverage-v8` (report in `coverage/apps/board`)

## Adding a skill

Skills are the reason this project exists, and they are the easiest contribution
to make. Create `skills/<techno>/<name>/SKILL.md` with YAML frontmatter followed
by the guidance body:

```markdown
---
name: postgres-query-performance
description: Diagnose and fix slow PostgreSQL queries with indexes and EXPLAIN
globs: ["**/*.sql", "**/*.repository.ts"]
---

Guidance body in Markdown…
```

- `<techno>` is matched against each repo's `technologies` list in the config.
- `name` and `description` are required; `globs` is optional. `name` must be
  unique across the whole library, not just within a technology — by
  convention `<techno>-<directory>`.
- Keep guidance concrete and reviewable — a skill is read by an agent about to
  edit someone's production code.

Renderers translate the same source into each target format (Claude Code, GitHub
Copilot, Cursor, Windsurf); you do not need to write per-platform variants.

## Architecture boundaries

Nx enforces module boundaries by `scope:*` tags (see `eslint.config.js`). Import
another project only through its package entry (`@lk/maggie-<name>`), never by
a deep relative path across project roots. `pnpm run lint` catches violations.

Package naming follows what is published: the libraries under `libs/` and the two
applications under `apps/` carry their public `@lk/maggie-*` names (`@lk/maggie-board`,
`@lk/maggie-server`). Nx project names (`config`, `board`, `server`, …) come from each
`project.json` (or the `nx` key of the package) and are independent of both.

## Dependency holds

One dependency is deliberately held back, and Dependabot is configured to stop
proposing it (`.github/dependabot.yml`):

| Package | Held at | Why |
|---|---|---|
| `typescript` | `~6.0.3` | TypeScript 7 is the native rewrite. Its npm package no longer exports the classic compiler API: the main entry is now `{ version, versionMajorMinor }` and everything else lives behind `typescript/unstable/*`. Nx's project-graph plugins still call `ts.readConfigFile`, so on TS 7 `nx show projects` — and therefore every lint/test/build target — fails with `ts.readConfigFile is not a function`. |

Nothing in this repository is written in TypeScript; `typescript` is present
only because Nx's plugins and editor tooling load it. Lift the hold once Nx
processes the project graph on TS 7 — check with `pnpm add -D -w typescript@7 && pnpm exec
nx reset && pnpm exec nx show projects` before touching `package.json`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(renderers): add windsurf target
fix(config): reject a config with both --config and --config-repo
docs: document the board path resolution order
chore(ci): pin actions/checkout to v4
```

Scopes usually map to a project (`sync`, `workspace`, `board`, `config`, `git`,
`renderers`, `skill-sync`) or to `skills` / `ci` / `docs`.

## Pull requests

1. Branch off `main`.
2. Make the change with tests; keep the diff focused on one concern.
3. Run `pnpm run lint && pnpm test && pnpm run build` before pushing.
4. Open the pull request and fill in the template — what changed, why, and how
   you verified it.
5. CI (`nx run-many -t lint test build`) must be green before review.

For anything larger than a bug fix, open an issue first so the design can be
discussed before you invest in the implementation.

## Releasing

Ten packages ship from this repository and are versioned **in lockstep**: the
`@lk/maggie-board` and `@lk/maggie-server` apps under `apps/` and the eight `@lk/maggie-*`
libraries under `libs/` (the repository root is private, it only carries the version the
tags follow). The packages depend on each other by caret range
(`^0.1.0`), so a version that moves in one place must move everywhere.

### Patch and minor releases (automatic)

Every push to `main` runs `.github/workflows/prepare-release.yml`, which looks
at commits since the last release tag and opens or updates a
`chore(release): vX.Y.Z` pull request with the version already bumped
(`node scripts/bump-version.js patch|minor`, run for you) and the
`Unreleased` section of `CHANGELOG.md` moved under the new version heading.
Any `feat:` commit produces a minor bump; any `fix:` commit (with no `feat:`)
produces a patch bump; anything else is a no-op. Review and merge that PR like
any other change.

If a commit contains a `BREAKING CHANGE:` footer or a `!` after its type
(`feat!:`), the workflow still opens a patch/minor PR but flags it as
recommending a manual major bump instead — it never bumps major on its own.

### Major releases (manual)

Run the bump script yourself:

```bash
node scripts/bump-version.js major
git add -A && git commit -m "chore(release): vX.Y.Z"
git push -u origin HEAD
```

Then open a PR the same way.

### Tagging and publishing (fully automatic)

Once the version-bump PR is merged to `main`, `prepare-release.yml` runs
again, notices `package.json` is now ahead of the last `v*` tag
(`scripts/should-tag-release.js`), and pushes the release tag itself — no
human action needed. It authenticates as the `RELEASE_PAT` repository secret,
a fine-grained personal access token belonging to `@linktogo` scoped to this
repo only (Contents: read/write). A repository tag ruleset still restricts
`v*` tag creation to the Admin role, so this only works because the token
belongs to an Admin account — anyone else's push is still rejected.

Pushing the tag triggers `.github/workflows/release.yml`, which verifies the
tag matches `package.json`, extracts the matching section of
`CHANGELOG.md`, and creates a GitHub Release with it as the notes — no
hand-written release notes needed.

That Release's `published` event triggers `.github/workflows/publish.yml`,
which runs `pnpm -r publish` (libraries, then the server, then the board, which depend on
them) with no manual approval step.

If `RELEASE_PAT` is missing or expired, the tagging step fails loudly in the
Actions log and nothing downstream (release, npm publish) happens — rotate it
by generating a new fine-grained PAT for `@linktogo` scoped to this repo and
updating the secret.

To rehearse a release against a local registry:

```bash
pnpm run publish:verdaccio   # publishes every package to http://localhost:4873
```

Check what a tarball would actually contain before releasing:

```bash
pnpm --filter @lk/maggie-board pack --dry-run                    # the board / `maggie` command
pnpm --filter @lk/maggie-renderers pack --dry-run        # one library
```

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/linktogo/maggie/issues/new/choose).
For anything security-sensitive, do **not** open a public issue — follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE) that covers this project.
