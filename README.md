# maggie

[![CI](https://github.com/linktogo/maggie/actions/workflows/ci.yml/badge.svg)](https://github.com/linktogo/maggie/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Tools to sync AI agent skills, practices, and workflows across repositories.

Skills are authored once under `skills/<techno>/<name>/SKILL.md` and translated
into each target platform's format (Claude Code, GitHub Copilot, Cursor,
Windsurf).

It ships the `maggie` command (render skills into repos, bootstrap a local
workspace, run the board and the agents server) — a kanban dashboard and the
server that launches local agents from it ([AI Factory](docs/ai-factory.md)), as an
[Nx](https://nx.dev) monorepo on pnpm workspaces. The board tracks local agent
sessions for both Claude Code and GitHub Copilot CLI.

## Why

Every repository in an organization ends up with its own drifting copy of the
same agent instructions — one for Claude Code, another for Copilot, a third for
Cursor. `maggie` keeps one reviewed source of truth: write the guidance once,
declare which technologies each repo uses, and let the tool render and open the
pull requests.

## Quick start

Requires **Node.js >= 22** and `git` on your PATH.

```bash
npm install -g @lk/maggie-board

# See what would be pushed to the repos in your config — no side effects
maggie sync --config repos.json --dry-run
```

The same install gives you the board and the server (via `@lk/maggie-server`), both
self-contained (the board's front-end ships pre-built, the skills library is bundled):

```bash
maggie                              # the board (http://localhost:4180) and the server (http://127.0.0.1:4318)
maggie --board                      # the board only (reads ./wk/.maggie/board.json or ./board.json)
maggie --server --repos repos.json  # the server only
maggie --repos repos.json --port 5000 --server-port 5100   # options go to the part they belong to
maggie sync --config repos.json     # render the skills into the repos
maggie workspace --config repos.json --workspace wk   # bootstrap a local workspace
```

Options are added after the mode and go to whichever part takes them (see
[the board](docs/board-dashboard.md) and [the server](docs/ai-factory.md)); with both
running, `--port` is the board's and `--server-port` the server's, and the board is
pointed at it. `--config-repo` / `--config-file` go to both. `--board <file>` (with a
value) still names the board file; a bare `--board` picks the mode.

Both answer on the loopback interface only. Without a global install, use
`npx -p @lk/maggie-board maggie` (the server alone: `npx @lk/maggie-server`).

The installed packages bundle the skills library, so the commands work from any
directory. A `skills/` folder in the current directory takes precedence, which
is what you want when working from a clone; `--skills <dir>` overrides both.

To hack on the project itself, work from a checkout:

```bash
git clone https://github.com/linktogo/maggie.git
cd maggie
pnpm install
node apps/board/bin/maggie.js sync --config repos.example.json --dry-run
```

Then copy `repos.example.json`, point it at your own repositories, and drop the
`--dry-run` when the preview looks right.

```bash
pnpm run wk     # clone those repos into ./wk and print the command to open them
pnpm start      # serve the board (auto-detects wk/.maggie/board.json)
```

`pnpm run wk` wires Claude Code hooks by default; add `-- --agent copilot` to
wire GitHub Copilot CLI instead. Sessions from both show up on the same board,
each card labelled with the agent behind it — see
[`maggie workspace` CLI](docs/workspace-cli.md#status-tracking).

New here? Read [Configuration](docs/configuration.md) next, then
[Adding a skill](CONTRIBUTING.md#adding-a-skill).

## Documentation

Full reference lives in [`docs/`](docs/README.md):

| Page | What it covers |
|---|---|
| [Configuration](docs/configuration.md) | The `repos.json` schema, and the two ways both CLIs resolve it |
| [Skills library](docs/skills-library.md) | Authoring skills, how they map to each target platform |
| [`maggie` CLI](docs/sync-cli.md) | Rendering skills into repos and pushing them |
| [`maggie workspace` CLI](docs/workspace-cli.md) | Bootstrapping a workspace, worktrees, status tracking |
| [Board dashboard](docs/board-dashboard.md) | The kanban dashboard, its server and endpoints |
| [CI status](docs/ci-status.md) | Per-contributor CI badges on the board, and how to enable them |
| [Retro-documentation](docs/retro-doc.md) | Folding a repository's specs and plans into one document an agent can read |
| [AI Factory](docs/ai-factory.md) | Launching local Claude Code / Copilot agents from the board through an independent server |
| [Architecture](docs/architecture.md) | Nx layout, module boundaries, testing and coverage gates |

`docs/superpowers/` holds the design record — one spec and plan per feature,
kept as history rather than maintained.

## Skills library

`skills/` ships a starter set of guidance, grouped by technology and matched
against each repo's `technologies` list: `nestjs`, `postgres`, `nextjs`,
`reactjs`, `angular`, `vuejs`, `nx`, `firebase`, `cloudflare`.

Add one by creating `skills/<techno>/<name>/SKILL.md` with YAML frontmatter
(`name`, `description`, optional `globs`) followed by the guidance body. Any
repo whose `technologies` include `<techno>` picks it up on the next sync — see
[Skills library](docs/skills-library.md).

## Published packages

Everything publishes under the single **`@lk`** scope. The `maggie` command ships in
`@lk/maggie-board` (the package you install, with the board UI), which runs the agents
server shipped in `@lk/maggie-server`; the libraries are published independently so they
can be reused on their own:

| Package | What it gives you |
|---|---|
| [`@lk/maggie-config`](libs/config) | load/validate the repo config from a file or a git repo |
| [`@lk/maggie-git`](libs/git) | thin git/`gh` wrapper |
| [`@lk/maggie-renderers`](libs/renderers) | render a skill for claude/copilot/cursor/windsurf |
| [`@lk/maggie-skill-sync`](libs/skill-sync) | skill resolution + the sync pipeline |
| [`@lk/maggie-workspace-bootstrap`](libs/workspace-bootstrap) | clone/install, Claude Code & Copilot CLI hooks, board state |
| [`@lk/maggie-ci-status`](libs/ci-status) | CI status payloads, validation and state mapping |
| [`@lk/maggie-retro-doc`](libs/retro-doc) | fold a repo's specs and plans into one agent-facing document |
| [`@lk/maggie-agent-runner`](libs/agent-runner) | run local agent CLIs on a checkout, with streamed output |

All are released in lockstep on the same version — see
[Releasing](CONTRIBUTING.md#releasing). The two apps are published too:
`@lk/maggie-board` (the `maggie` command and the board) and `@lk/maggie-server`.

## Tests

```bash
pnpm test          # nx run-many -t test: every lib/app, 100% coverage gate each
pnpm run test:board # apps/board suite only: server (node:test) + front-end (vitest)
pnpm run check:coverage # fails if any project no longer enforces 100% coverage
```

CI runs `nx run-many -t lint test build`. Because Nx detects the package
manager from the lockfile, keep `pnpm-lock.yaml` as the only lockfile — a
`package-lock.json` breaks the Nx project graph. Layout, testing conventions and
the reasons behind them are in [Architecture](docs/architecture.md).

## Contributing

Contributions are welcome — especially new skills, which are the easiest way in.
Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the coverage
bar, the commit format, and how to add a skill. Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

- 🐛 [Report a bug](https://github.com/linktogo/maggie/issues/new/choose)
- 💡 [Propose a feature or a skill](https://github.com/linktogo/maggie/issues/new/choose)
- 🔒 Security issues: see [SECURITY.md](SECURITY.md) — never a public issue

Release notes live in [CHANGELOG.md](CHANGELOG.md).

## Security model

The CLIs run git and package-manager commands on your machine: they clone the
repositories named in the config, install their dependencies, and shell out to
`gh` when `--pr` is passed. Treat the config file — and any repository you pass
to `--config-repo` — as trusted input. The board server is a local development
tool with no authentication and should not be exposed to a network. See
[SECURITY.md](SECURITY.md) for the full scope and reporting process.

## License

[Apache License 2.0](LICENSE) © Linktogo.

Third-party material redistributed in this repository is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
