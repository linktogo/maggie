# AI Factory Message Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI Factory's one-shot run console with persisted, resumable conversation threads browsable per project and per request.

**Architecture:** `libs/agent-runner` gains a SQLite thread store, a Claude stream-json parser and a thread service that wires the existing run manager to the store. `apps/agents` exposes `/projects` and `/threads` (the `/runs` routes go away) and owns the DB file. The board replaces `FactoryPage` with a three-pane message center fed by a new `useThreads` composable; the relay is unchanged.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite` `DatabaseSync`, `node:test`), Vue 3 + vue-router + Vitest, `marked` + `DOMPurify`.

**Spec:** `docs/superpowers/specs/2026-11-07-factory-message-center-design.md`

## Global Constraints

- `engines.node` is `>=22.13` in the root `package.json`, `libs/agent-runner/package.json` and `apps/agents/package.json`.
- SQLite through `node:sqlite` only; no native dependency.
- `libs/agent-runner` and `apps/agents` keep the 100% lines/functions/branches coverage gate; `apps/board` is exempt but every new composable and component gets a test file.
- Thread ids: `'th_'` + 16 random hex chars. Run ids stay `run-<n>`.
- Limits: user message ≤ 32 KB (32_768 chars) → `400`; step `input` truncated to 4 KB (4096 chars of its JSON); thread pages of 50; title = first 80 chars of the trimmed prompt, else the skill id.
- Thread status values: `running`, `idle`, `failed`, `archived`. Message roles: `user`, `agent`, `system`. Message kinds: `text`, `step`, `status`, `error`.
- Default DB path: `~/.maggie/factory.db`, overridable with `--db <file>`.
- Only Claude threads are resumable (`provider === 'claude-cli'` and a `sessionId`).
- Every user-visible board string lives in all four locales (`en`, `fr`, `de`, `es`) under `factory.*`.
- `marked` and `DOMPurify` are added with exact versions (no `^`), both at least two weeks old.
- **No agent creates git commits.** Each task ends with a checkpoint where the human reviews and commits.
- Before Task 1, the working tree must be clean (the pending `trust.js` / pnpm work committed or stashed by the human).

## Review Focus

1. **A stream-json line split across stdout chunks, or a multi-byte character cut in two** — the parser must reassemble it and emit exactly one message (Task 2).
2. **Replying in a thread while another thread runs on the same repo** — `409` with a message naming the repo, the thread stays `idle`, no user message is stored (Task 4), and the composer shows the reason (Task 8).
3. **The server is killed mid-run and restarted** — the thread comes back `idle` (or `failed` without a session) with an "interrupted by a restart" system message, and is resumable (Tasks 1 and 6).
4. **Agent markdown containing `<script>`, `onerror=` or `javascript:` links** — rendered inert (Task 8).
5. **A repo removed from the allowlist while its threads remain in the DB** — `GET /threads/:id` still works, `POST /threads/:id/messages` answers `404 unknown repo`, `/projects` lists only allowlisted repos (Task 5).

---

### Task 1: Thread store

**Files:**
- Create: `libs/agent-runner/src/store.js`
- Modify: `libs/agent-runner/src/index.js`, `libs/agent-runner/package.json`, `apps/agents/package.json`, `package.json` (engines)
- Test: `libs/agent-runner/test/store.test.js`, `libs/agent-runner/test/index.test.js`

**Interfaces:**
- Produces: `createThreadStore({ path = ':memory:', now = () => new Date(), randomId }) → store` with
  - `createThread({ repo, provider, model, skill, title }) → Thread` (status `running`)
  - `getThread(id) → Thread | null`
  - `updateThread(id, { status?, sessionId? }) → Thread` (bumps `updatedAt`)
  - `deleteThread(id) → void` (cascades messages)
  - `listThreads({ repo?, status?, q?, before?, limit = 50 }) → Thread[]` newest `updatedAt` first; `archived` excluded unless `status === 'archived'`; `q` is a case-insensitive `LIKE` on `title` and on `text` messages' `content`; `before` is an `updatedAt` cursor (exclusive)
  - `projectStats() → [{ repo, threads, running, lastActivity }]` (non-archived counts)
  - `addMessage(threadId, { role, kind, content, runId = null }) → Message`; an object `content` is stored as JSON and returned parsed; a `step` content's `input` is truncated so its JSON is ≤ 4096 chars (replaced by `{ truncated: true, preview: <first 4096 chars> }`)
  - `listMessages(threadId, { after = 0 } = {}) → Message[]` by ascending `id`
  - `recoverInterrupted() → number`: every `running` thread → `idle` if it has a `sessionId`, else `failed`, plus a `system/status` message with content `'interrupted by a restart'`
  - `close()`
  - `Thread = { id, repo, provider, model, skill, title, sessionId, status, createdAt, updatedAt }`, `Message = { id, threadId, role, kind, content, runId, createdAt }`
- Migrations keyed on `PRAGMA user_version` (schema from the spec = version 1); `PRAGMA journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`.

- [ ] **Step 1: Write the failing tests** in `store.test.js` (all on `:memory:`, fixed `now`, deterministic `randomId`):
  - `migrates a fresh database to version 1` — `PRAGMA user_version` is `1`; reopening does not re-run it.
  - `creates, reads and updates a thread` — `createThread` returns `status: 'running'`, `sessionId: null`; `updateThread(id, { status: 'idle', sessionId: 's1' })` changes `updatedAt`.
  - `stores text and step messages, parsing step content back` — `addMessage(id, { role: 'agent', kind: 'step', content: { tool: 'Edit', summary: 'src/a.js', input: { file_path: 'src/a.js' } } })` round-trips as an object.
  - `truncates a step input over 4096 characters` — input `{ text: 'x'.repeat(10_000) }` comes back as `{ truncated: true, preview }` with `preview.length === 4096`.
  - `deleting a thread deletes its messages`.
  - `lists threads newest first, 50 per page, with a before cursor`.
  - `hides archived threads unless asked for them`.
  - `searches titles and text messages, case-insensitively` — `q: 'FLAKY'` finds a thread titled "fix flaky test" and one whose agent text mentions "flaky"; step content is not searched.
  - `projectStats counts non-archived and running threads per repo`.
  - `recoverInterrupted marks running threads idle or failed with a system message` — returns `2` for one thread with a session (→ `idle`) and one without (→ `failed`).
  - In `index.test.js`, add `createThreadStore` to the expected exports.

- [ ] **Step 2: Run to verify they fail**
  Run: `node --test libs/agent-runner/test/store.test.js`
  Expected: FAIL, `Cannot find module '../src/store.js'`.

- [ ] **Step 3: Implement `createThreadStore` in `store.js`**, export it from `index.js`, set `engines.node` to `>=22.13` in the three `package.json` files. Use prepared statements; `LIKE ? ESCAPE '\'` with `%`/`_` escaped in `q`.

- [ ] **Step 4: Run the lib suite with coverage**
  Run: `npx nx test agent-runner`
  Expected: PASS, 100% lines/functions/branches.

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 2: Stream parser

**Files:**
- Create: `libs/agent-runner/src/stream.js`
- Modify: `libs/agent-runner/src/index.js`
- Test: `libs/agent-runner/test/stream.test.js`, `libs/agent-runner/test/fixtures/claude-stream.jsonl`

**Interfaces:**
- Produces: `createStreamParser(provider) → { push(text: string) → Parsed[], end() → Parsed[] }` where
  `Parsed = { kind: 'text', content } | { kind: 'step', content: { tool, summary, input } } | { kind: 'session', sessionId } | { kind: 'result', sessionId, costUsd, durationMs, isError }`.
  - `claude-cli`: buffers until `\n`, parses each line as JSON. `system`/`init` → `session`. `assistant` → one `text` per `text` block, one `step` per `tool_use` block. `result` → `result` (`total_cost_usd`, `duration_ms`, `is_error`). `user` (tool results) and unknown types → nothing. A non-JSON line → `text` with the raw line. `end()` flushes a trailing unterminated line the same way.
  - `copilot`: every pushed chunk → `text` as is; `end()` → `[]`.
  - `summary` = the first present of `input.file_path`, `input.command`, `input.pattern`, `input.url`, `input.description`, else `''`, cut to 120 chars.
- Also export `summarizeTool(tool, input) → string`.

- [ ] **Step 1: Write the fixture** `claude-stream.jsonl`: one `system/init` line (`session_id: "sess-1"`), one `assistant` line with a text block and a `tool_use` `Edit` with `file_path: "src/a.js"`, one `user` tool_result line, one `assistant` text line, one `result` line (`total_cost_usd: 0.08`, `duration_ms: 72000`, `is_error: false`, `session_id: "sess-1"`).

- [ ] **Step 2: Write the failing tests**
  - `parses a whole claude stream into session, text, step and result` — pushing the fixture yields exactly `[session sess-1, text, step {tool:'Edit', summary:'src/a.js'}, text, result {costUsd:0.08, durationMs:72000, isError:false}]`.
  - `reassembles a line split across chunks` — the fixture pushed 7 characters at a time yields the same list.
  - `keeps an unparsable line as text` — `push('not json\n')` → `[{ kind: 'text', content: 'not json' }]`.
  - `ignores unknown event types`.
  - `flushes an unterminated last line on end`.
  - `passes copilot output through as text`.
  - `summarizeTool picks the first meaningful field and caps it at 120 characters`.

- [ ] **Step 3: Run to verify they fail**
  Run: `node --test libs/agent-runner/test/stream.test.js` — Expected: FAIL, module not found.

- [ ] **Step 4: Implement `stream.js`** and export `createStreamParser`, `summarizeTool` from `index.js` (update `index.test.js`).

- [ ] **Step 5: Run** `npx nx test agent-runner` — Expected: PASS, 100% coverage.

- [ ] **Step 6: Checkpoint** — stop; the human reviews and commits.

---

### Task 3: Resume and stream-json in the run manager

**Files:**
- Modify: `libs/agent-runner/src/providers.js`, `libs/agent-runner/src/run.js`
- Test: `libs/agent-runner/test/providers.test.js`, `libs/agent-runner/test/run.test.js`

**Interfaces:**
- Produces: `commandFor(provider, model = null, { resume = null } = {})`. For `claude-cli` the args become `['-p', ...modelArgs, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose', ...(resume ? ['--resume', resume] : [])]`. Copilot unchanged; `resume` with `copilot` → `AgentError('invalid', 'copilot threads cannot be resumed')`.
- `validateSessionId(id)`: `/^[A-Za-z0-9-]{1,128}$/`, else `AgentError('invalid', 'invalid session id')`.
- `manager.start({ ..., resume = null })` passes `resume` through (validated); the run view gains no new field.

- [ ] **Step 1: Update the failing tests**
  - `providers.test.js`: `claude args include stream-json and verbose`; `claude args end with --resume <id> when resuming`; `copilot cannot resume`; `rejects a session id that could read as an option` (`'--dangerous'`).
  - `run.test.js`: update the existing args assertion to the new list; add `start passes resume to the claude command`.

- [ ] **Step 2: Run** `node --test libs/agent-runner/test/providers.test.js libs/agent-runner/test/run.test.js` — Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement** in `providers.js` and `run.js`; export `validateSessionId`.

- [ ] **Step 4: Run** `npx nx test agent-runner` — Expected: PASS, 100% coverage.

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 4: Thread service

**Files:**
- Create: `libs/agent-runner/src/threads.js`
- Modify: `libs/agent-runner/src/index.js`
- Test: `libs/agent-runner/test/threads.test.js`

**Interfaces:**
- Consumes: `createThreadStore` (Task 1), `createStreamParser` (Task 2), `manager.start/cancel/subscribe` with `resume` (Task 3), `buildPrompt`, `loadSkill`, a repo resolver `{ resolve(name), names() }`.
- Produces: `createThreadService({ store, manager, repos, skillsDir, defaultProvider, log = () => {} })` with
  - `start({ repo, provider?, model?, prompt?, skill? }) → Thread` — validates like today's `startRun`, starts the run **before** creating the thread (a `busy` refusal leaves nothing behind), stores the user message (`content` = prompt; with a skill, `` `skill ${id}` `` then a blank line then the prompt if any)
  - `reply(id, { prompt }) → Thread` — `404` unknown thread; `400` when not resumable (`'this thread cannot be resumed'`), when archived, when `prompt` is empty or > 32_768 chars; `409` while the thread runs; `404` when its repo is no longer allowlisted (from `repos.resolve`); starts with `resume: thread.sessionId` before storing the user message
  - `stop(id) → Thread` — `404` when no active run
  - `setStatus(id, 'archived' | 'idle') → Thread` — `409` while running, `400` for other values
  - `remove(id)` — `409` while running
  - `get(id) → { thread, messages } | null`, `list(query)`, `projects() → [{ repo, threads, running, lastActivity }]` for every `repos.names()` entry (zeros / `null` when none)
  - `subscribe(id, listener) → unsubscribe | null` — listener receives `{ type: 'message', message }` and `{ type: 'status', status }`; when the thread is not running, it gets one `status` event immediately
- Run → thread wiring: one parser per run; `stdout` → parser → `session` sets `sessionId` (first one wins), `text`/`step` stored as `agent` messages with the run id, `result` keeps cost/duration; `stderr` stored as `system/error`. On a terminal status: flush the parser, store `system/status` with content `{ outcome, durationMs, costUsd, error }` (`outcome` is the run status), then the thread becomes `idle` if it has a `sessionId` or any agent message, else `failed`. A store write that throws is logged and the run continues; the next successful write is preceded by a `system/error` message `'some output could not be saved'`.

- [ ] **Step 1: Write the failing tests** with the fake `spawn` from `run.test.js` (extract `fakeChild`/`harness` into `test/helpers.js`) and a `:memory:` store:
  - `start creates a running thread with the user message and streams agent messages into it`.
  - `the session id from init is saved and the thread goes idle on success` — final messages end with `system/status` `{ outcome: 'succeeded', costUsd: 0.08, durationMs: 72000 }`.
  - `reply resumes the claude session` — spawn args end with `['--resume', 'sess-1']`.
  - `a first run failing before any session leaves the thread failed`.
  - `a busy repo refuses a new thread without creating it` — `AgentError` code `busy`, `store.listThreads()` empty.
  - `replying while another thread runs on the same repo is refused and stores nothing` — code `busy`, message count unchanged, thread still `idle`.
  - `copilot threads and archived threads cannot be resumed` — code `invalid`.
  - `a reply over 32768 characters is refused`.
  - `stop cancels the active run and the thread settles idle`.
  - `archiving or deleting a running thread is refused`.
  - `subscribe delivers stored messages live and a status at the end; an idle thread gets its status at once`.
  - `a failed store write is logged and reported at the next write`.
  - `projects lists every allowlisted repo, with zeros when it has no thread`.

- [ ] **Step 2: Run** `node --test libs/agent-runner/test/threads.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `threads.js`**, export `createThreadService` (update `index.test.js`).

- [ ] **Step 4: Run** `npx nx test agent-runner` — Expected: PASS, 100% coverage.

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 5: `/projects` and `/threads` routes

**Files:**
- Modify: `apps/agents/src/server.js`
- Test: `apps/agents/test/server.test.js`

**Interfaces:**
- Consumes: the thread service (Task 4).
- Produces: `createAgentsServer({ token, threads, repos, skillsDir, providers, allowedOrigins, bodyLimit, log })` — `threads` replaces `manager`. Routes exactly as in the spec's API table; `/runs*` → `404`. SSE frames: `event: message\ndata: <Message JSON>\n\n` and `event: status\ndata: {"status": ...}\n\n`; the response ends when a status other than `running` is sent. `GET /threads` reads `repo`, `status`, `q`, `before` from the query string. The server log keeps one line per request and logs `[<thread id>] <status>` on each status event.

- [ ] **Step 1: Rewrite the run-route tests as thread-route tests** (real `createThreadService` with a `:memory:` store and fake spawn):
  - `POST /threads starts a thread and answers 202`; `400` without prompt or skill; `404` unknown repo or skill; `409` busy repo.
  - `GET /threads filters by repo, status and q`; `GET /threads/:id` returns thread and messages; `404` unknown.
  - `POST /threads/:id/messages resumes`; `400` copilot; `409` running; `413` body over the limit.
  - `a thread whose repo left the allowlist can be read but not resumed` — `GET` 200, `POST .../messages` 404.
  - `GET /threads/:id/events replays nothing, streams new messages, then ends on idle`; `an idle thread's stream sends its status and ends`.
  - `DELETE /threads/:id/run stops it`; `404` with no active run.
  - `PATCH archives and restores`; `409` while running; `DELETE /threads/:id` removes; `409` while running.
  - `GET /projects lists allowlisted repos with counts`.
  - `the legacy /runs routes are gone` — `404`.
  - Keep the auth, Host, Origin and body-limit tests unchanged.

- [ ] **Step 2: Run** `node --test apps/agents/test/server.test.js` — Expected: FAIL on the new routes.

- [ ] **Step 3: Implement the routes** in `server.js` (thread path regex `^\/threads\/(th_[0-9a-f]{16})(\/messages|\/events|\/run)?$`).

- [ ] **Step 4: Run** `npx nx test agents` — Expected: `server.test.js` PASS (`main.test.js` may fail until Task 6).

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 6: `--db`, startup recovery and docs

**Files:**
- Modify: `apps/agents/src/main.js`, `docs/ai-factory.md`, `CONTRIBUTING.md` (only if the dev setup section mentions Node 22)
- Test: `apps/agents/test/main.test.js`

**Interfaces:**
- Consumes: `createThreadStore`, `createThreadService`.
- Produces: `main(argv, { ..., openStore = createThreadStore })`; `--db <file>` (default `path.join(home, '.maggie', 'factory.db')`, parent directory created `0700` like the token's); `defaultDbFile(home)` exported. Before listening: open the store (on failure throw `Error(\`Could not open the factory database ${file}: ${cause}\`)`), call `recoverInterrupted()` and log `  recovered N interrupted thread(s)` when N > 0. The store is closed on server `close`. `installSqliteWarningFilter(proc = process)`: drops `ExperimentalWarning`s whose message mentions `SQLite`, re-emits every other warning; called from `bin/agents.js` before importing `main.js`.

- [ ] **Step 1: Write the failing tests** in `main.test.js`:
  - `opens the database given with --db and recovers interrupted threads` (temp dir file, pre-seeded with one `running` thread → log line `recovered 1 interrupted thread(s)`, thread `idle`/`failed`).
  - `defaults the database to ~/.maggie/factory.db` (fake `home`).
  - `refuses to start when the database cannot be opened` — `openStore` throws → rejects with `/Could not open the factory database/`, token file not written.
  - `closes the database when the server stops`.
  - `the warning filter drops only SQLite experimental warnings` (fake `proc` emitter).
  - Update existing tests that construct `createAgentsServer` with `manager`.

- [ ] **Step 2: Run** `node --test apps/agents/test/main.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement** in `main.js` and `bin/agents.js`; rewrite `docs/ai-factory.md` (threads concept, `--db` row in the flag table, Node ≥ 22.13, the new API table replacing `/runs`, resume limits: Claude only, a purged Claude session ends the reply `failed`; replace "Runs are in memory only" in Known limitations with "one active run per repo, no queue").

- [ ] **Step 4: Run** `npx nx test agent-runner agents` — Expected: PASS, 100% coverage on both.

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 7: `useThreads` composable

**Files:**
- Create: `apps/board/src/useThreads.js`
- Delete: `apps/board/src/useFactory.js`, `apps/board/src/useFactory.test.js`
- Test: `apps/board/src/useThreads.test.js`

**Interfaces:**
- Consumes: the `/api/factory/*` routes from Task 5 (same `api()` helper shape as `useFactory.js`).
- Produces: `useThreads({ fetchImpl = fetch, EventSourceImpl = globalThis.EventSource, pollMs = 5000, doc = globalThis.document })` returning refs `health, skills, projects, threads, thread, messages, error, available, busy` and functions:
  - `load()` — health + skills + projects; sets `available` like `useFactory`
  - `loadThreads({ repo, q = '', archived = false })`
  - `open(id)` — `GET /threads/:id`, then follows `/events` while `thread.status === 'running'`
  - `create({ repo, provider, model, prompt, skill }) → Thread | null`, `reply(prompt) → boolean`, `stop()`, `archive(id)`, `restore(id)`, `remove(id)`
  - `resumable` computed: `thread.provider === 'claude-cli' && !!thread.sessionId && thread.status === 'idle'`
  - On SSE `message` → push to `messages` (skip ids already present); on `status` ≠ `running` → close the stream, refresh `thread`, `projects` and `threads`. On `onerror` while running → close and `open(id)` again (reload, not replay).
  - `/projects` is polled every `pollMs` while `doc.visibilityState === 'visible'`; polling and the stream stop on unmount.
  - API errors set `error` to the server's `error` text (or `HTTP <status>`).

- [ ] **Step 1: Write the failing tests** (fake fetch and the `FakeEventSource` from `FactoryPage.test.js`, `vi.useFakeTimers()`):
  - `load fills health, skills and projects`; `marks the factory unavailable on 503`.
  - `open loads a thread and follows its events while running`.
  - `a streamed message already loaded is not duplicated`.
  - `the stream closes on idle and the lists refresh`.
  - `a dropped stream reloads the thread instead of replaying it`.
  - `reply posts the prompt and follows the new run`; `a 409 sets error and keeps the thread idle`.
  - `resumable is false for copilot, without a session, or while running`.
  - `polls projects only while the page is visible, and stops on unmount`.

- [ ] **Step 2: Run** `npx vitest run apps/board/src/useThreads.test.js` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `useThreads.js`**; delete `useFactory.js` and its test.

- [ ] **Step 4: Run** `npx vitest run apps/board/src/useThreads.test.js` — Expected: PASS.

- [ ] **Step 5: Checkpoint** — stop; the human reviews and commits.

---

### Task 8: Message center UI

**Files:**
- Create: `apps/board/src/FactoryProjects.vue`, `FactoryThreads.vue`, `FactoryConversation.vue`, `FactoryComposer.vue`, `FactoryNewRequest.vue`, `apps/board/src/markdown.js`, and a `.test.js` next to each
- Modify: `apps/board/src/FactoryPage.vue`, `FactoryPage.test.js`, `router.js`, `App.vue` (props for the new routes), `App.test.js`, `locales/{en,fr,de,es}.js`, `apps/board/package.json` (`marked`, `dompurify`, exact versions)

**Interfaces:**
- Consumes: `useThreads` (Task 7), `useRelativeTime`, `Icon`, `useI18n`.
- Produces:
  - Routes `/factory` (`name: 'factory'`), `/factory/:repo` (`'factory-repo'`), `/factory/:repo/:threadId` (`'factory-thread'`), all on `FactoryPage`; `App.vue` passes `{ fetchImpl }` for the three names and highlights the nav tab for all three.
  - `renderMarkdown(text) → string` in `markdown.js`: `DOMPurify.sanitize(marked.parse(text))`, links forced to `target="_blank" rel="noopener noreferrer"`.
  - `FactoryPage` holds `useThreads` and the route; selecting a project or thread pushes the route; on narrow screens (`< md`) only the deepest selected pane shows, with a back button (`data-test=factory-back`).
  - `FactoryProjects` props `{ projects, selected }`, emits `select(repo)`, `search(q)`.
  - `FactoryThreads` props `{ threads, selected, archived }`, emits `select(id)`, `new`, `toggle-archived`, `archive(id)`, `restore(id)`; shows a badge per status (`factory.thread.running|idle|failed|archived`) and the relative `updatedAt`.
  - `FactoryConversation` props `{ thread, messages }`: user/agent bubbles; consecutive `step` messages of one `runId` collapsed into one `<details>` (`data-test=factory-steps`, label `factory.steps` with count and tool tally, e.g. "6 steps (Read ×3, Edit ×2, Bash)"); agent text via `renderMarkdown` in `v-html`; `system/error` in the warning colour; `system/status` as a divider showing outcome, duration and cost when present.
  - `FactoryComposer` props `{ thread, resumable, error }`, emits `send(prompt)`, `stop`, `restart`; disabled with `factory.cannotResume` (copilot or no session) or while running (shows Stop instead); shows **Restart as a new request** (`data-test=factory-restart`) when not resumable or the last status outcome is `failed`.
  - `FactoryNewRequest`: today's form (repo, provider, model, prompt/skill, same defaults and `canRun` rule), emits `submit(body)`; `restart` prefills it with the thread's repo, provider, model and last user prompt.
  - Remove the now-unused `factory.runs`, `factory.follow`, `factory.output`, `factory.noOutput` keys from all four locales.

- [ ] **Step 1: Add dependencies** — `npm install --workspace apps/board --save-exact marked@<version> dompurify@<version>` with versions at least two weeks old.

- [ ] **Step 2: Write the failing tests**
  - `markdown.test.js`: `renders markdown`; `removes scripts, event handlers and javascript: links` (input `<script>x</script><img src=x onerror=alert(1)>[a](javascript:alert(1))` → output contains none of `<script`, `onerror`, `javascript:`); `opens links in a new tab`.
  - `FactoryProjects.test.js`: `lists projects with counts and a running dot`; `emits select and search`.
  - `FactoryThreads.test.js`: `shows status badges and relative times`; `emits new, select, archive and restore`.
  - `FactoryConversation.test.js`: `collapses the steps of a turn with a tool tally`; `renders agent markdown and user text as plain text`; `shows the outcome divider with duration and cost`.
  - `FactoryComposer.test.js`: `sends a trimmed prompt`; `is disabled with a reason for copilot threads and offers a restart`; `shows Stop while running`.
  - `FactoryNewRequest.test.js`: port the form tests from today's `FactoryPage.test.js` (repo/provider defaults, skill mode, `canRun`), plus `prefills from a restart`.
  - `FactoryPage.test.js` (rewritten): `deep link /factory/api/th_… opens that thread`; `selecting a project then a thread updates the route`; `creating a request opens its thread`; `a busy repo error is shown in the composer`; `the unavailable banner is unchanged`.
  - `App.test.js`: the nav tab is active on `/factory/api/th_0123456789abcdef`.

- [ ] **Step 3: Run** `npx nx test board` — Expected: FAIL on the new tests.

- [ ] **Step 4: Implement** the components, `markdown.js`, routes and locale keys (all four locales; the i18n test enforces matching keys).

- [ ] **Step 5: Run** `npx nx test board` and `npx nx run-many -t lint` — Expected: PASS, no lint errors.

- [ ] **Step 6: Manual check** — `npm run agents -- --repos repos.json --workspace wk` and `npm start`; open `/factory`, start a Claude request, reply once, restart the agents server mid-run and confirm the thread comes back with "interrupted by a restart"; check light/dark themes and a 375 px wide window.

- [ ] **Step 7: Checkpoint** — stop; the human reviews and commits.
