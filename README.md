# maggie

[![CI](https://github.com/linktogo/maggie/actions/workflows/ci.yml/badge.svg)](https://github.com/linktogo/maggie/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 24.22.1](https://img.shields.io/badge/node-%3E%3D24.22.1-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Tools to sync AI agent skills, practices, and workflows across repositories.

Skills are authored once under `skills/<techno>/<name>/SKILL.md` and translated
into each target platform's format: the [Agent Skills](https://agentskills.io) standard
with an `AGENTS.md` index (Codex, Gemini CLI, OpenCode…), Claude Code, GitHub Copilot,
Cursor and Windsurf. The library is linted for secrets and injection patterns before
anything is synced, `maggie sync --check` reports which repos drifted, and
`maggie eval` measures what each skill actually changes.

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

## What it does

| | |
|---|---|
| **Render everywhere** | One `SKILL.md` becomes an [Agent Skills](https://agentskills.io) directory (`.agents/skills/`, read by Codex, Gemini CLI, OpenCode, Goose…), a Claude Code skill, a Copilot instructions file, a Cursor rule and a Windsurf rule. |
| **Keep `AGENTS.md` yours** | The `agents` target lists the repo's skills in a managed block of `AGENTS.md`; everything the team wrote around it is left alone. |
| **Ship more than Markdown** | Scripts, references and assets next to a `SKILL.md` are synced with it. |
| **Lint before you sync** | `maggie lint` checks structure and scans for secrets, `curl \| sh`, prompt injection and hidden Unicode — a skill runs with the agent's permissions in every repo it reaches. `maggie sync` refuses a library with errors. |
| **Know what drifted** | `maggie sync --check` compares every repo's default branch with the current render, pushes nothing, and feeds the board. |
| **Measure each skill** | `maggie eval` runs a skill's cases with a real agent, without and with the skill, and reports the difference. |
| **Watch the agents** | The board tracks local Claude Code and Copilot CLI sessions, CI, cost and budget, and the AI Factory launches agents from it. |

## Quick start

Requires **Node.js >= 24.22.1** and `git` on your PATH (the agent CLIs, `claude` or `copilot`, for `maggie eval` and the AI Factory).

```bash
npm install -g @linktogo/maggie-board

# See what would be pushed to the repos in your config — no side effects
maggie sync --config repos.json --dry-run
```

The same install gives you the board and the server (via `@linktogo/maggie-server`), both
self-contained (the board's front-end ships pre-built, the skills library is bundled):

```bash
maggie                              # the board (http://localhost:4180) and the server (http://127.0.0.1:4318)
maggie --board                      # the board only (reads ./wk/.maggie/board.json or ./board.json)
maggie --server --repos repos.json  # the server only
maggie --repos repos.json --port 5000 --server-port 5100   # options go to the part they belong to
maggie sync --config repos.json     # render the skills into the repos
maggie sync --config repos.json --check   # which repos drifted? (pushes nothing)
maggie lint                         # scan the skills library
maggie eval --skill nestjs-module-structure   # with vs without the skill
maggie workspace --config repos.json --workspace wk   # bootstrap a local workspace
```

Options are added after the mode and go to whichever part takes them (see
[the board](docs/board-dashboard.md) and [the server](docs/ai-factory.md)); with both
running, `--port` is the board's and `--server-port` the server's, and the board is
pointed at it. `--config-repo` / `--config-file` go to both. `--board <file>` (with a
value) still names the board file; a bare `--board` picks the mode.

Both answer on the loopback interface only. Without a global install, use
`npx -p @linktogo/maggie-board maggie` (the server alone: `npx @linktogo/maggie-server`).

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
`--dry-run` when the preview looks right. To see which repos have drifted — and get
the result on the board — schedule a check:

```bash
maggie sync --config repos.json --check --out wk/.maggie/sync-status.json
```

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
| [Configuration](docs/configuration.md) | The `repos.json` schema, the targets, and the two ways both CLIs resolve it |
| [Skills library](docs/skills-library.md) | Authoring skills and their supporting files, how they map to each target, the `AGENTS.md` index, `maggie lint` and `maggie eval` |
| [`maggie` CLI](docs/sync-cli.md) | Rendering skills into repos and pushing them, pruning, drift detection with `--check` |
| [`maggie workspace` CLI](docs/workspace-cli.md) | Bootstrapping a workspace, worktrees, status tracking |
| [Board dashboard](docs/board-dashboard.md) | The kanban dashboard, its server and endpoints, the skills sync status |
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

A skill is a directory:

```
skills/nestjs/module-structure/
├── SKILL.md              # frontmatter (name, description, optional globs) + guidance
├── scripts/…             # optional supporting files, synced with the skill
└── evals/                # optional cases for maggie eval, never synced
    ├── feature-module.json
    └── starter/          # the checkout the agent starts from
```

Any repo whose `technologies` include `<techno>` picks it up on the next sync.
Before opening a pull request, check it and measure it:

```bash
maggie lint --strict                          # what CI runs on this library
maggie eval --skill nestjs-module-structure   # pass rate without vs with the skill
```

See [Skills library](docs/skills-library.md) for the frontmatter, the rendering per
target, the lint rules and the eval format.

## Published packages

Everything publishes under the single **`@linktogo`** scope. The `maggie` command ships in
`@linktogo/maggie-board` (the package you install, with the board UI), which runs the agents
server shipped in `@linktogo/maggie-server`; the libraries are published independently so they
can be reused on their own:

| Package | What it gives you |
|---|---|
| [`@linktogo/maggie-config`](libs/config) | load/validate the repo config from a file or a git repo |
| [`@linktogo/maggie-git`](libs/git) | thin git/`gh` wrapper |
| [`@linktogo/maggie-renderers`](libs/renderers) | render a skill for agents/claude/copilot/cursor/windsurf |
| [`@linktogo/maggie-skill-sync`](libs/skill-sync) | skill resolution, the sync pipeline, drift check, lint and evals |
| [`@linktogo/maggie-workspace-bootstrap`](libs/workspace-bootstrap) | clone/install, Claude Code & Copilot CLI hooks, board state |
| [`@linktogo/maggie-ci-status`](libs/ci-status) | CI status payloads, validation and state mapping |
| [`@linktogo/maggie-retro-doc`](libs/retro-doc) | fold a repo's specs and plans into one agent-facing document |
| [`@linktogo/maggie-agent-runner`](libs/agent-runner) | run local agent CLIs on a checkout, with streamed output |

All are released in lockstep on the same version — see
[Releasing](CONTRIBUTING.md#releasing). The two apps are published too:
`@linktogo/maggie-board` (the `maggie` command and the board) and `@linktogo/maggie-server`.

## Tests

```bash
pnpm test          # nx run-many -t test: every lib/app, 100% coverage gate each
pnpm run test:board # apps/board suite only: server (node:test) + front-end (vitest)
pnpm run check:coverage # fails if any project no longer enforces 100% coverage
pnpm run lint:skills    # maggie lint --strict on skills/
```

CI runs `nx run-many -t lint test build` and lints the skills library. Because Nx detects the package
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
to `--config-repo` — as trusted input. The same goes for the skills library: what it
says is followed by the agents of every repository it is synced to. `maggie lint`
catches the known shapes of a malicious or leaky skill (secrets, remote code piped
to a shell, injection phrasing, hidden characters) but does not replace review.
`maggie eval` runs a real agent with edit rights, and the commands its cases name,
in temporary directories. The board server is a local development
tool with no authentication and should not be exposed to a network. See
[SECURITY.md](SECURITY.md) for the full scope and reporting process.

## License

[Apache License 2.0](LICENSE) © Linktogo.

Third-party material redistributed in this repository is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
