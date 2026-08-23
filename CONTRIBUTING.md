# Contributing to maggie

Thanks for taking the time to contribute. This document covers how to get the
project running locally, what the test bar is, and how changes get merged.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

Requirements: **Node.js >= 22** and **npm** (see below — npm is not optional here).

```bash
git clone https://github.com/linktogo/maggie.git
cd maggie
npm ci
npm test
```

The repo is an [Nx](https://nx.dev) monorepo using npm workspaces: applications
in `apps/`, shared libraries in `libs/`, the skills library in `skills/`. See
[Project layout](README.md#project-layout) for what each project does.

> **Keep `package-lock.json` as the only lockfile.** Nx detects the package
> manager from the lockfile; adding a `pnpm-lock.yaml` or `yarn.lock` breaks the
> project graph and the CI build.

## Running things locally

```bash
npm test            # nx run-many -t test — every lib/app, 100% coverage gate each (except board)
npm run test:board  # apps/board only: server (node:test) + front-end (vitest)
npm run lint        # nx run-many -t lint
npm run build       # nx run-many -t build
npm start           # build + serve the kanban dashboard
```

The screenshots in `docs/images` are generated, not captured by hand:

```bash
npm run board:build
NODE_PATH="$(npm root -g)" node docs/screenshots/capture.mjs
```

`docs/screenshots/capture.mjs` serves the built board with a stub API and its
own demo data — one scene per image — so a UI change can be reflected in the
docs by rebuilding and re-running it. It needs Playwright and a Chromium
(`npm i -g playwright && playwright install chromium`); it is deliberately not
a project dependency, since nothing in CI runs it.

To exercise the CLIs against the sample config without touching any real repo:

```bash
node apps/sync/bin/sync.js --config repos.example.json --dry-run
node apps/workspace/bin/workspace.js --config repos.example.json --workspace /tmp/ws --dry-run
```

## Tests and the coverage gate

Every library and CLI app enforces a **100% coverage gate** (`apps/board` is
exempt). A patch that lowers coverage fails CI, so new code needs new tests.

This project is developed test-first: write the failing test, make it pass, then
refactor. If a change is genuinely untestable, say so in the pull request rather
than lowering the threshold.

Tests live next to the code they cover:

- `libs/*/test/*.test.js` and `apps/{sync,workspace}/test/*.test.js` — `node:test`
- `apps/board/src/*.test.js` — `vitest` + `@vue/test-utils`

## Adding a skill

Skills are the reason this project exists, and they are the easiest contribution
to make. Create `skills/<techno>/<name>/SKILL.md` with YAML frontmatter followed
by the guidance body:

```markdown
---
name: query-performance
description: Diagnose and fix slow Postgres queries.
globs: ["**/*.sql"]
---

Guidance body in Markdown…
```

- `<techno>` is matched against each repo's `technologies` list in the config.
- `name` and `description` are required; `globs` is optional.
- Keep guidance concrete and reviewable — a skill is read by an agent about to
  edit someone's production code.

Renderers translate the same source into each target format (Claude Code, GitHub
Copilot, Cursor, Windsurf); you do not need to write per-platform variants.

## Architecture boundaries

Nx enforces module boundaries by `scope:*` tags (see `eslint.config.js`). Import
another project only through its package entry (`@linktogo/maggie-<name>`), never by
a deep relative path across project roots. `npm run lint` catches violations.

Package naming follows what is published: the five libraries under `libs/` carry
their public `@linktogo/maggie-*` names, while the applications under `apps/` stay
`private` and keep internal `@maggie/*` names, since they are never published on
their own. Nx project names (`config`, `sync`, …) come from each `project.json`
and are independent of both.

## Dependency holds

One dependency is deliberately held back, and Dependabot is configured to stop
proposing it (`.github/dependabot.yml`):

| Package | Held at | Why |
|---|---|---|
| `typescript` | `~6.0.3` | TypeScript 7 is the native rewrite. Its npm package no longer exports the classic compiler API: the main entry is now `{ version, versionMajorMinor }` and everything else lives behind `typescript/unstable/*`. Nx's project-graph plugins still call `ts.readConfigFile`, so on TS 7 `nx show projects` — and therefore every lint/test/build target — fails with `ts.readConfigFile is not a function`. |

Nothing in this repository is written in TypeScript; `typescript` is present
only because Nx's plugins and editor tooling load it. Lift the hold once Nx
processes the project graph on TS 7 — check with `npm i -D typescript@7 && npx
nx reset && npx nx show projects` before touching `package.json`.

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
3. Run `npm run lint && npm test && npm run build` before pushing.
4. Open the pull request and fill in the template — what changed, why, and how
   you verified it.
5. CI (`nx run-many -t lint test build`) must be green before review.

For anything larger than a bug fix, open an issue first so the design can be
discussed before you invest in the implementation.

## Releasing

Six packages ship from this repository and are versioned **in lockstep**: the
CLI package `@linktogo/maggie` (the repo root) and the five `@linktogo/maggie-*`
libraries under `libs/`. The libraries depend on each other by caret range
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
which runs `npm publish --workspaces` (libraries) and then `npm publish` (the
CLI package, which depends on them) with no manual approval step.

If `RELEASE_PAT` is missing or expired, the tagging step fails loudly in the
Actions log and nothing downstream (release, npm publish) happens — rotate it
by generating a new fine-grained PAT for `@linktogo` scoped to this repo and
updating the secret.

To rehearse a release against a local registry:

```bash
npm run publish:verdaccio   # publishes the five libraries to http://localhost:4873
```

Check what a tarball would actually contain before releasing:

```bash
npm pack --dry-run                                # the CLI package
npm pack --dry-run --workspace @linktogo/maggie-renderers # one library
```

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/linktogo/maggie/issues/new/choose).
For anything security-sensitive, do **not** open a public issue — follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE) that covers this project.
