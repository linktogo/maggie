# Workspace Kanban Board — Design

**Date:** 2026-06-16
**Status:** Approved (pending written-spec review)

## Purpose

Add per-repo status tracking to the `ai-workspace` bootstrap so that, while Claude
Code works across the cloned repos of a workspace, each repo's progress is visible
as a kanban board. The board surfaces — above all — which repos have a **pending
question** waiting on the human.

Four states: `todo` | `inprogress` | `question` | `done`.

The board itself is a separate web app (Vue 3 + Tailwind) living in a sub-folder of
this repository.

## Decisions (locked during brainstorming)

- **Status updates** are written automatically by **Claude Code hooks** for
  `inprogress` and `question`.
- **`done`** is marked **explicitly by Claude** (it runs a CLI command when it
  considers the task finished).
- **Visualization** is a **Vue.js + Tailwind web app** in a sub-folder of this repo.
- **Transport**: a small **Node server exposes the state as JSON**; the Vue app
  **polls** it.
- **Architecture**: Approach A — a single CLI write path + an atomic JSON state
  file; the server only *reads* the file. Writers (hooks + Claude) work whether or
  not the board server is running.

## Architecture overview

```
Claude Code session (per repo)
  ├─ hook UserPromptSubmit ─┐
  ├─ hook Notification ─────┤  ai-workspace status <repo> <state> --board <path>
  ├─ hook Stop ─────────────┤            │ atomic read-modify-write
  └─ Claude runs `... done` ─┘            ▼
                                  <workspaceDir>/.ai-sync/board.json
                                            ▲ read
                              apps/board/server.js  (GET /api/board, serves dist/)
                                            ▲ poll every N s
                              apps/board Vue 3 + Tailwind (4 kanban columns)
```

## Section 1 — State model and `board.json`

Single JSON file at the workspace root: `<workspaceDir>/.ai-sync/board.json`.

```json
{
  "version": 1,
  "repos": {
    "example-api": { "status": "inprogress", "updatedAt": "2026-06-16T10:32:00Z", "lastEvent": "UserPromptSubmit" },
    "example-web": { "status": "question",   "updatedAt": "2026-06-16T10:30:11Z", "lastEvent": "Notification" }
  }
}
```

- States: `todo` | `inprogress` | `question` | `done`.
- On `bootstrap`, each repo is initialized to `todo` (without clobbering an existing
  entry for that repo if the board already exists).
- Each write updates `status`, `updatedAt` (ISO 8601), and `lastEvent` (the origin
  of the change — hook name or `manual`/`done`).
- Writes are **atomic**: write to a temp file then `rename`, to avoid races when
  several repos write concurrently.
- A missing/empty board file is treated as `{ version: 1, repos: {} }`.

## Section 2 — Status writing: subcommand + hooks

The `ai-workspace` CLI moves to a **subcommand** model:

- `ai-workspace bootstrap …` — the current behavior; **default** when no recognized
  subcommand is given (back-compat with today's flags).
- `ai-workspace status <repo> <state>` — applies a transition to the board.
- `ai-workspace board …` — launches the board server (Section 3).

`status` resolves the board path from `--board <path>` or the `AI_SYNC_BOARD`
environment variable, validates `<state>` against the four allowed values, and
applies the transition atomically.

### Hook installation

`bootstrap` writes, into each checkout, a `.claude/settings.local.json` (a **local,
git-ignored** settings file — it does not pollute the repo's tracked `settings.json`)
registering the hooks below. The `<repo>` name and the board path are baked in at
install time.

| Hook (Claude Code)  | Command                                   | → state      |
|---------------------|-------------------------------------------|--------------|
| `UserPromptSubmit`  | `ai-workspace status <repo> inprogress`   | `inprogress` |
| `Notification`      | `ai-workspace status <repo> question`     | `question`   |
| `Stop`              | `ai-workspace status <repo> question`     | `question`   |

`Stop → question` means: Claude finished its turn and is now waiting on the human.

If a `.claude/settings.local.json` already exists in the checkout, the hook entries
are merged in (existing unrelated settings preserved).

### `done`

Marked explicitly by Claude running `ai-workspace status <repo> done`. `bootstrap`
deposits a short instruction (in the generated `settings.local.json` and/or a local
notes file in the checkout) telling Claude the exact command to run when it considers
the task finished. A later `UserPromptSubmit` naturally moves the repo back to
`inprogress`.

## Section 3 — Board app: `apps/board/`

Dedicated sub-folder with its own `package.json` (front-end built with Vite). Two
parts:

### Node server — `apps/board/server.js`

- Native `http`, **zero runtime dependencies**.
- `GET /api/board` → reads `board.json` (path via `--board`/`AI_SYNC_BOARD`) and
  returns the JSON. A missing board yields `{ version: 1, repos: {} }`.
- Serves the static Vue build from `apps/board/dist/`.
- Launched via `ai-workspace board` or `node apps/board/server.js`; port configurable
  with `--port` (default **4173**).

### Front-end — `apps/board/src/` (Vue 3 + Tailwind)

- Four kanban columns: `todo` / `inprogress` / `question` / `done`. Each repo is a
  card showing name, relative `updatedAt`, and `lastEvent`.
- The `question` column is visually emphasized (alert color) — the most actionable
  signal for the user.
- **Polls** `/api/board` every **N seconds** (default **3s**, configurable), reactive
  re-render.
- Tailwind for styling; Vite build → `dist/` served by the server.

## Section 4 — Testing

- **Core (ai-sync, `node:test`)** — the project enforces **100% coverage** on
  `src/**`, so new core logic must be fully covered:
  - status write logic: transitions, atomic write, init to `todo`, `updatedAt` /
    `lastEvent` fields, board-path resolution, invalid-state rejection.
  - subcommand routing through `main` (`bootstrap` / `status` / `board`, default to
    `bootstrap`).
  - hook generation: `bootstrap` produces a correct `settings.local.json` (right
    commands, `<repo>`, board path) and merges with an existing file.
- **Server** — light test of `GET /api/board` (returns the read JSON; missing board →
  empty repos) against a temp board file.
- **Front-end (Vue)** — kept light: component render of columns/cards from a mocked
  state, or a smoke test. Front-end code lives outside `src/**`, so it is not bound by
  the 100% coverage gate.

## Out of scope (YAGNI)

- Real-time push (SSE/WebSocket) — polling is sufficient.
- Editing status from the board UI — the board is read-only.
- Persisting history/audit beyond the latest `lastEvent`.
- Authentication on the local server.

## Open implementation notes

- Keep the status write logic in a small, focused module (e.g. `src/board.js`) with
  injectable fs/clock deps, mirroring the existing `bootstrap` testing style.
- Decide where Claude reads the "how to mark done" instruction: simplest is a comment
  field in the generated `settings.local.json` plus a one-line note appended to a
  local file the user already points Claude at.
