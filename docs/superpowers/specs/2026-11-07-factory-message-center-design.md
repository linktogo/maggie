# AI Factory — message center

Date: 2026-11-07
Status: draft, awaiting review

## Goal

Turn the board's AI Factory tab from a one-shot run console into a **message center**: a persisted
history of agent conversations, browsable **per project** (allowlisted repo) and **per request**
(a thread). A thread is a conversation: the user can reply and the agent resumes its own session.

## Decisions

| Topic | Decision |
|---|---|
| What a request is | A conversation thread; follow-ups resume the agent session (`claude --resume <session_id>`) |
| Agent message rendering | Claude runs with `--output-format stream-json --verbose`; text is shown, tool steps are collapsed per turn |
| Copilot | First answer only, rendered as plain text; the thread is not resumable in v1 ("restart as a new request") |
| Storage | SQLite through `node:sqlite` (`DatabaseSync`), owned by `maggie-agents` |
| Node floor | `engines.node` raised to `>=22.13` (root and `apps/agents`); only the SQLite `ExperimentalWarning` is filtered in `main.js` |
| Concurrency | Still one active run per repo; an idle thread holds no lock; no queue |
| Legacy `/runs` routes | Removed; the board is their only client |

## Architecture

```
board (Vue) ──/api/factory/*──▶ board server (relay, holds the token; unchanged)
                                      │
                                      ▼
                             maggie-agents (HTTP + SSE)
                                 │              │
                     createThreadStore     createRunManager
                     (SQLite)              (spawn claude / copilot)
```

### Units

- **`libs/agent-runner/src/store.js`** (new) — `createThreadStore({ path })`. Opens the DB (`:memory:`
  in tests), applies numbered migrations keyed on `PRAGMA user_version`, sets `journal_mode=WAL` and
  `busy_timeout`. Pure persistence: threads, messages, listing, search, recovery. No process knowledge.
- **`libs/agent-runner/src/stream.js`** (new) — pure parser. `createStreamParser(provider)` takes stdout
  chunks and yields normalized messages: `{ kind: 'text', content }`, `{ kind: 'step', tool, summary,
  input }`, `{ kind: 'result', sessionId, costUsd, durationMs }`. Handles lines split across chunks.
  An unparsable line becomes `text`. Copilot mode passes stdout through as `text`.
- **`libs/agent-runner/src/run.js`** (extended) — keeps process lifecycle (lock per repo, timeout,
  SIGTERM then SIGKILL). New `resume` option → `--resume <id>`; Claude gets the stream-json flags. The
  in-memory event buffer stays for live SSE.
- **`libs/agent-runner/src/threads.js`** (new) — `createThreadService({ store, runs, repos, skills })`
  wires the two: creates a thread, starts a run, feeds the parser output into the store as it arrives,
  sets `session_id` from the first `result`, settles thread status at the end of a run.
- **`apps/agents/src/server.js`** — `/threads` and `/projects` routes; `/runs` removed.
- **`apps/agents/src/main.js`** — new `--db <file>` flag (default `~/.maggie/factory.db`); startup
  recovery; refuses to start when the DB cannot be opened.
- **Board** — `useThreads.js` replaces `useFactory.js`; `FactoryPage.vue` becomes a three-pane layout
  built from `FactoryProjects.vue`, `FactoryThreads.vue`, `FactoryConversation.vue`,
  `FactoryComposer.vue`, `FactoryNewRequest.vue`. `agentsProxy.js` is unchanged (it already forwards
  `/api/factory/*` generically).

## Data model

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,          -- 'th_' + random
  repo TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  skill TEXT,                   -- skill of the first message, if any
  title TEXT NOT NULL,          -- first 80 chars of the first prompt, else the skill id
  session_id TEXT,              -- Claude session id, set by the first `result`
  status TEXT NOT NULL,         -- 'running' | 'idle' | 'failed' | 'archived'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'user' | 'agent' | 'system'
  kind TEXT NOT NULL,           -- 'text' | 'step' | 'status' | 'error'
  content TEXT NOT NULL,        -- text, or JSON { tool, summary, input } for a step
  run_id TEXT,                  -- groups the messages of one agent turn
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, id);
CREATE INDEX threads_repo ON threads(repo, updated_at DESC);
```

### Thread status

- `running` while a run is active.
- `idle` ("waiting for you") after a run ends — succeeded, failed, cancelled or timed out — when the
  thread has a `session_id` (or is a Copilot thread with an answer). The outcome is recorded as a
  `system/status` message, with duration and cost when known.
- `failed` when the first run ends before any `session_id` or answer exists.
- `archived` hides the thread from the default list; `PATCH` restores it to `idle`.

### Limits

- A user message is at most 32 KB (`400` otherwise).
- A step's `input` is truncated to 4 KB; raw stdout is never stored as such.
- Thread list pages hold 50 threads (`before=<updated_at>` cursor).

## API

`maggie-agents`, exposed by the board under `/api/factory/*`. Auth, Host and Origin checks unchanged.

| Route | Behaviour |
|---|---|
| `GET /health`, `GET /skills` | unchanged |
| `GET /projects` | `{ projects: [{ repo, threads, running, lastActivity }] }` for every allowlisted repo |
| `GET /threads?repo=&status=&q=&before=` | newest first, 50 per page; `q` is a `LIKE` over titles and text messages; archived excluded unless `status=archived` |
| `POST /threads` | `{ repo, provider?, model?, prompt?, skill? }` (prompt or skill) → `202 { thread }`; starts the first run |
| `GET /threads/:id` | `{ thread, messages }` |
| `POST /threads/:id/messages` | `{ prompt }` → `202 { thread }`; resumes with `--resume`. `409` when the thread or its repo is busy, `400` when the thread is not resumable (Copilot, no `session_id`, archived) |
| `GET /threads/:id/events` | SSE: `message` events (newly stored messages) and `status`; ends when the thread leaves `running`. Without an active run it sends the current status and ends |
| `DELETE /threads/:id/run` | SIGTERM the active run → `202`; `404` when none |
| `PATCH /threads/:id` | `{ status: 'archived' \| 'idle' }`; `409` while running |
| `DELETE /threads/:id` | permanent delete (cascade); `409` while running |

Errors keep the current vocabulary: `400`, `401`, `403`, `404`, `409`, `413`; the board relay answers
`503 agents-unavailable` when the server or its token is missing.

## Startup recovery

Threads still `running` in the DB (the server was killed) are set to `idle` (or `failed` if they have
no `session_id`) with a `system` message "interrupted by a restart".

## UI

Three panes on desktop; on narrow screens one pane at a time (projects → threads → conversation) with
a back button.

```
┌─ Projects ─────┬─ Requests: maggie ─────────┬─ Fix the flaky board test ──── claude · opus ─┐
│ 🔍 search      │ [+ New request]            │  you · 10:42                                   │
│ ● maggie    3  │ [All ▾] [☐ archived]       │  The Card.test.js test fails randomly in CI…   │
│   oc-be     1  │ ● Fix the flaky board…     │                                                │
│   site      —  │   running · 2 min          │  agent · 10:43                                 │
│                │ ○ Add CI badge             │  ▸ 6 steps (Read ×3, Edit ×2, Bash npm test)    │
│                │   waiting · yesterday      │  The test relied on an unmocked Date.now()…    │
│                │                            │  ─ finished · 1m12s · $0.08 ─                  │
│                │                            │  [ Reply…                     ] [Send] [Stop]  │
└────────────────┴────────────────────────────┴────────────────────────────────────────────────┘
```

- **Projects**: allowlisted repos with open-thread count and a running dot; the search box applies
  `q` across projects.
- **Requests**: threads of the selected project with status badge and relative time
  (`useRelativeTime`), archived toggle. **New request** shows the existing form (provider, model,
  prompt or skill) in the conversation pane, project preselected.
- **Conversation**: user and agent bubbles; steps collapsed per turn and expandable; stderr and errors
  as red `system` messages. Agent text is rendered as markdown with `marked` + `DOMPurify` (exact
  pinned versions). The composer is disabled with a reason when the thread is not resumable or the
  repo is busy, and offers **Restart as a new request** (prefilled with the last prompt).
- **Live updates**: SSE for the open thread only; `/projects` polled every 5 s while the tab is
  visible. When an SSE stream drops mid-run, the thread is reloaded with `GET /threads/:id` rather
  than replayed, so nothing is duplicated.
- **Routes**: `/factory`, `/factory/:repo`, `/factory/:repo/:threadId` in `router.js`.
- Existing tokens, `Icon`, i18n (FR/EN), themes and dark mode.

## Error handling

- Unparsable stream-json line → stored as `agent/text`; never fails the run.
- `--resume` failure (session purged) → run ends `failed`, explicit `system` message; composer offers
  **Restart as a new request**.
- DB cannot be opened at startup → `maggie-agents` exits with the path and cause; no in-memory fallback.
- A write fails mid-run → logged to stderr; the run and SSE continue; an `error` message is added to
  the thread at the next successful write.
- Agents server missing → existing `503` banner.

## Testing

`libs/agent-runner` and `apps/agents` keep the 100% coverage gate; `apps/board` is exempt but gets
tests for every new composable and component.

- `stream.test.js`: real stream-json fixtures (text, tool_use, tool_result, result with session id),
  a line split across chunks, a truncated line, an unknown type, Copilot plain text.
- `store.test.js` (on `:memory:`): migrations, CRUD, cascade delete, pagination, `q` search, startup
  recovery, step input truncation.
- `run.test.js`: fake `spawn`; `--resume` and stream-json arguments.
- `threads.test.js`: thread lifecycle (first run, `session_id` capture, resume, failure before session,
  busy repo, Copilot not resumable).
- `server.test.js`: every route and error code, SSE replay then live, with the store on `:memory:`
  and a fake CLI; `main.test.js`: `--db`, startup refusal, recovery.
- Board: `useThreads.test.js` (fake fetch and EventSource, reload on drop), the five components,
  composer disabled states, step folding, deep-link routing, markdown sanitization (`<script>` removed).

## Documentation

Rewrite `docs/ai-factory.md` (threads, `--db`, Node ≥ 22.13, resume limits, removed `/runs` API);
update `CONTRIBUTING.md` if the dev setup changes.

## Out of scope (v1)

Run queue, Copilot resume, full-text search (FTS5), export, several parallel runs per repo,
migration of in-memory runs (there is nothing persisted to migrate).
