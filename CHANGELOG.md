# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From `1.0.0` onward, breaking changes only ship in a major release. The `0.x`
line, released under the project's former `ai-sync` name, allowed breaking
changes in minor releases.

## [Unreleased]

### Added

- The status board now tracks **GitHub Copilot CLI** sessions locally, alongside
  Claude Code ones. `maggie-workspace --agent copilot` merges Copilot hooks into
  each checkout's `.github/copilot/settings.local.json` (`sessionStart`,
  `userPromptSubmitted`, `notification`, `agentStop`, `sessionEnd`) and prints a
  `copilot` launch command; `--editor` still picks the launch command on its own
  when the two should differ. Both agents feed the same `board.json`, and each
  session card carries a badge naming the agent behind it.
- Token usage for Copilot sessions is read from its
  `~/.copilot/session-state/<id>/events.jsonl` event stream, mapped onto the
  same four counters as Claude Code transcripts, so cards and history totals
  stay comparable across agents.
- New `maggie-workspace messages <repo>` subcommand: drains a session's queued
  dashboard messages without touching its status. Copilot drops the stdout of a
  `userPromptSubmitted` hook, so queued messages are delivered on `sessionStart`
  and `notification` instead, returned as `additionalContext` — which means a
  message sent while the agent is idle or waiting on a permission prompt reaches
  it without waiting for your next prompt.

### Changed

- `--worktree` is now supported with `--agent copilot` too; it is rejected only
  for `--editor vscode` (previously it required `--editor claude`).
- Board hook reconciliation on server start now reconciles whichever agents a
  checkout is wired for, detected from the settings files present, and names the
  agent in its log line.

## [1.1.0] - 2026-08-19

### Added

- You can now send a message to a session straight from the board dashboard —
  from the input on the session card or in the detail side panel — instead of
  going back to the terminal where the session runs. The message is queued on
  the board (`POST /api/sessions/message`) and relayed into the conversation by
  the `UserPromptSubmit` hook the next time that session takes a turn.
- Session cards on the board now show a worktree badge when a session runs in
  a git worktree (bootstrapped with `--worktree <branch>`), so isolated tasks
  are distinguishable at a glance. The branch name is captured by the status
  hooks and surfaced with a tooltip.
- The board dashboard is now translated: English by default, switchable to
  French, German or Spanish from the header picker. The choice is persisted in
  `localStorage` and re-applied on the next visit.

### Changed

- **Breaking (UI):** the dashboard used to render in French only; it now starts
  in English for every visitor, whatever their browser language.

## [1.0.0] - 2026-08-17

### Changed

- **BREAKING — the project is renamed from `ai-sync` to `maggie`.** The
  repository moved to <https://github.com/linktogo/maggie>, and every published
  package, CLI binary and on-disk state directory follows the new name:

  | Before | After |
  |---|---|
  | `@linktogo/ai-sync` | `@linktogo/maggie` |
  | `@linktogo/ai-ci-status` | `@linktogo/maggie-ci-status` |
  | `@linktogo/ai-config` | `@linktogo/maggie-config` |
  | `@linktogo/ai-git` | `@linktogo/maggie-git` |
  | `@linktogo/ai-renderers` | `@linktogo/maggie-renderers` |
  | `@linktogo/ai-skill-sync` | `@linktogo/maggie-skill-sync` |
  | `@linktogo/ai-workspace-bootstrap` | `@linktogo/maggie-workspace-bootstrap` |
  | `ai-sync` (CLI) | `maggie` |
  | `ai-workspace` (CLI) | `maggie-workspace` |
  | `<workspace>/.ai-sync/` | `<workspace>/.maggie/` |

  The `@linktogo/ai-*` packages remain on npm at `0.6.0` and receive no further
  releases. GitHub redirects the old repository URL, so existing clones keep
  fetching until their remote is updated.

  To migrate an installation:

  ```bash
  npm uninstall -g @linktogo/ai-sync
  npm install -g @linktogo/maggie
  git remote set-url origin https://github.com/linktogo/maggie.git
  mv <workspace>/.ai-sync <workspace>/.maggie   # preserves the board history
  ```

  Workspaces bootstrapped by an earlier version also carry `ai-workspace status`
  hooks in their `.claude/settings.local.json`; re-run `maggie-workspace
  bootstrap` to rewrite them.

## [0.6.0] - 2026-08-15

### Fixed

- The release pipeline now tags and publishes without manual steps:
  `prepare-release.yml` pushes the release tag itself once the version-bump PR
  merges to `main`, and `release.yml` creates the GitHub Release with a
  personal access token instead of the default `GITHUB_TOKEN` — GitHub does
  not fire the `release: published` event for releases created by the default
  token, which had silently prevented `publish.yml` from ever running.

## [0.5.0] - 2026-08-14

## [0.4.0] - 2026-08-14

## [0.3.0] - 2026-08-14

## [0.2.0] - 2026-08-14

### Added

- Community and governance files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, and this changelog.
- GitHub issue forms (bug, feature, skill proposal), a pull request template,
  a `CODEOWNERS` file, and a Dependabot configuration for npm and GitHub Actions.
- `ai-sync --skills <dir>` to point the CLI at a specific skills library.
- The board server (`npm start`) now accepts `--config-repo <url>` (plus
  optional `--config-file`) to pull `/api/config` and hook-reconciliation data
  from a shared config repo, the same as the `ai-sync`/`ai-workspace` CLIs,
  instead of only a local `--config <path>`.
- The board now tracks each session's token usage (input/output/cache,
  recomputed live on every `Stop`) and keeps a permanent `history.jsonl`
  record of every session's final usage after it ends, browsable in a new
  "Historique" tab (`GET /api/history`).
- The "Historique" tab now lives at its own `/history` route and adds
  consumption charts — by day/week/month/year, and by project — on top of
  the existing detailed session table, with a Tokens ⇄ € toggle. Token usage
  is now tracked per model (`message.model`) so the € estimate uses each
  model's own price instead of a single blended rate.
- A session card can now be dragged onto the "Done" column to close it by
  hand (`POST /api/sessions/close`) — the same effect as a normal
  `SessionEnd`, for when that hook doesn't fire (crash / hard kill).
- The five libraries are now published to npm as `@linktogo/ai-config`,
  `@linktogo/ai-git`, `@linktogo/ai-renderers`, `@linktogo/ai-skill-sync`, and
  `@linktogo/ai-workspace-bootstrap`, alongside the `@linktogo/ai-sync` CLI
  package — each with its own README, license, and metadata. All six release in
  lockstep on the same version. The applications under `apps/` stay private and
  keep their internal `@ai-sync/*` names.

### Fixed

- The published CLI package was unusable: `files` referenced paths that do not
  exist at the repository root, and no runtime dependencies were declared. It
  now ships `apps/sync`, `apps/workspace`, the bundled skills library, and real
  dependency ranges.
- `ai-sync` resolved its skills directory as `./skills` relative to the current
  directory, so a globally installed CLI found no skills at all. It now prefers
  a local `skills/` folder and falls back to the library bundled in the package.

### Changed

- Documentation and the `wk` script no longer hardcode the organization-private
  `lk-config` repository; `npm run wk` now runs against the bundled
  `repos.example.json`, and the docs use a placeholder config repo URL.
- Removed the local Verdaccio `publishConfig.registry` from the workspace
  libraries; the `publish:verdaccio` script passes `--registry` explicitly.
- Filled in the copyright line of the Apache-2.0 `LICENSE` appendix.

## [0.1.0]

Initial release.

### Added

- `ai-sync` CLI: resolve skills per repository from `skills/<techno>/<name>/SKILL.md`,
  render them for Claude Code, GitHub Copilot, Cursor, and Windsurf, then branch,
  commit, push, and optionally open a pull request.
- `--config` / `--config-repo` config sources, with `--config-file`, `--repo`,
  `--dry-run`, and a `--strict` guardrail that fails on a technology with no skills.
- `ai-workspace` CLI: clone the configured repositories into a workspace, install
  dependencies cache-first (npm/pnpm, Maven), support out-of-workspace checkouts
  via `path`, create git worktrees, and print the editor launch command.
- Kanban status tracking: Claude Code hooks per checkout writing to a shared
  `board.json`, plus a `status` subcommand to update it by hand.
- Board dashboard (Vue 3 + Tailwind) with a zero-dependency server, browser
  notifications, a summary header, filtering, and a repo detail panel.
- Starter skills library for NestJS, Postgres, Next.js, React, Angular, Vue, Nx,
  Firebase, and Cloudflare Workers.

[Unreleased]: https://github.com/linktogo/maggie/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/linktogo/maggie/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/linktogo/maggie/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/linktogo/maggie/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/linktogo/maggie/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/linktogo/maggie/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/linktogo/maggie/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/linktogo/maggie/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/linktogo/maggie/releases/tag/v0.1.0
