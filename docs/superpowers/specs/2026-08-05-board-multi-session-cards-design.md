# Board Multi-Session Cards — Design

**Date:** 2026-08-05
**Status:** Approved (pending written-spec review)

## Purpose

`board.json` is keyed by repo name only: `repos[repoName] = { status, updatedAt,
lastEvent, events }`. Every Claude Code hook invocation (`UserPromptSubmit`,
`Notification`, `Stop`) for a repo writes to that same single entry. When two
Claude Code sessions run against the same repo checkout at once, the second
session's hook events overwrite the first's, so the board only ever shows one
card for that repo — the other session is invisible.

This feature makes the board session-aware: each Claude Code session gets its
own tracked entry, with a stable title taken from its first prompt, and cards
reflect that a repo can have multiple sessions in different states at once.

## Decisions (locked during brainstorming)

- **Grouped by repo, not flattened.** A repo keeps one visual identity; its
  card lists the sessions currently in that card's status, rather than each
  session becoming a fully independent card.
- **A repo's card appears in every column that has at least one of its
  sessions.** If one session is `question` and another is `inprogress`, the
  repo shows up in both columns. Each instance of the card lists **only** the
  sessions matching that column's status — no duplicated session rows across
  columns.
- **Session identity = Claude Code's `session_id`**, already present on every
  hook's JSON stdin payload (`session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, plus event-specific fields).
- **Title = the first `UserPromptSubmit` prompt for that `session_id`**,
  truncated for display (~60 chars), stored once and never overwritten by
  later events. Read directly from the hook payload's `prompt` field — no
  transcript-file parsing needed, since the first `UserPromptSubmit` of a
  session already carries the exact text we want.
- **Cards also show the latest prompt, separately from the title.** Each
  session tracks a second field, `lastPrompt`, overwritten on every
  `UserPromptSubmit` (unlike `title`, which is set once). The card shows it
  clipped to 140 characters with a "voir plus" toggle to expand the full
  text when it's longer — the title tells you which session is which at a
  glance, `lastPrompt` tells you what it's doing right now.
- **Manual CLI usage keeps working.** `ai-workspace status <repo> <state>`
  run by hand (no JSON piped into stdin, i.e. stdin is a TTY) has no
  `session_id` to key off. It falls back to a fixed pseudo-session key
  `"manual"`, with no title. This is a distinct entry from any real Claude
  session, so it can't collide with or clobber hook-driven sessions.
- **Session removal via a new `SessionEnd` hook.** All `source` values
  (`clear`, `resume`, `logout`, `prompt_input_exit`,
  `bypass_permissions_disabled`, `other`) are treated identically: the
  session's process is going away, so its entry is deleted from the board.
  This does not catch a hard kill/crash (no hook fires), which is accepted —
  same class of gap as today's board never removing anything.
- **A repo with zero active sessions still shows up** (empty `sessions: {}`),
  in the `todo` column — same "not started yet" placeholder behavior
  `initRepos` already provides today.
- **`board.json` is disposable runtime state, not data to migrate.** It's
  regenerated continuously by hooks and isn't hand-edited. On reading a file
  at `version !== 2` (or a repo still in the old flat shape), `readBoard`
  resets that repo to `{ sessions: {} }` rather than writing a schema
  migrator — hooks repopulate it within moments.
- **Notifications and counts move from per-repo to per-session.** The
  question/done desktop notification, the tab-title badge count, and the
  `SummaryHeader` totals all operate on sessions, not repos, so two blocked
  sessions on one repo count as two, not one — and a notification names the
  session's title so you know which one needs you.

## Architecture overview

```text
Claude Code hook fires (UserPromptSubmit | Notification | Stop | SessionEnd)
  │  stdin: { session_id, transcript_path, cwd, hook_event_name, prompt?, message?, source? }
  ▼
ai-workspace status <repo> <state> --board <path> --event <name>   (existing 3 events)
ai-workspace session-end <repo> --board <path>                     (new)
  │
  ├─ status/session-end command reads stdin JSON → { sessionId, prompt }
  ├─ setSessionStatus(boardPath, repo, sessionId, state, { lastEvent, title? })
  │     └─ title only set the first time this sessionId is seen for this repo
  └─ removeSession(boardPath, repo, sessionId)   (SessionEnd only)
  │
  ▼
board.json  { version: 2, repos: { <name>: { sessions: { <sessionId>: {...} } } } }
  │
  ▼
GET /api/board  (server.js, unchanged passthrough — no server-side computation)
  │
  ▼
apps/board/src (Vue)
  useBoard.js       — per-session diffing for transitions/notifications
  App.vue           — groups repos into (status → [{ name, sessions }]) per column
  Card.vue          — repo name + one row per session (title, relative time)
  RepoDetail.vue     — opened per session: history for that session_id
  SummaryHeader.vue  — counts sessions, not repos
```

## Section 1 — `board.js` (`libs/workspace-bootstrap/src/board.js`)

Replace the flat repo entry with a `sessions` map. New/changed exports:

```js
export async function setSessionStatus(boardPath, repo, sessionId, state, opts = {}) {
  const { lastEvent = 'manual', title, lastPrompt, now = () => new Date().toISOString(), ...io } = opts;
  if (!STATES.includes(state)) throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  const board = await readBoard(boardPath, io);
  const at = now();
  const repoEntry = (board.repos[repo] ??= { sessions: {} });
  const prevSession = repoEntry.sessions[sessionId];
  const events = [{ event: lastEvent, at }, ...(prevSession?.events ?? [])].slice(0, MAX_EVENTS);
  repoEntry.sessions[sessionId] = {
    status: state,
    updatedAt: at,
    lastEvent,
    title: prevSession?.title ?? title ?? null,          // set once, never overwritten
    lastPrompt: lastPrompt ?? prevSession?.lastPrompt ?? null, // overwritten every UserPromptSubmit
    events,
  };
  await writeBoard(boardPath, board, io);
  return board;
}

export async function removeSession(boardPath, repo, sessionId, opts = {}) {
  const board = await readBoard(boardPath, opts);
  if (board.repos[repo]) delete board.repos[repo].sessions[sessionId];
  await writeBoard(boardPath, board, opts);
  return board;
}
```

- `readBoard` bumps to `{ version: 2, repos: {} }` as the default shape, and
  for any repo entry that isn't already `{ sessions: {...} }` shape (i.e. old
  flat `{status, updatedAt, ...}` from a v1 file, or malformed), replaces it
  with `{ sessions: {} }` — the reset described in Decisions.
- `initRepos` changes its seed value from a flat status object to
  `{ sessions: {} }` per repo name.
- `setStatus` (old name) is removed; all call sites move to
  `setSessionStatus`.

## Section 2 — Hook wiring (`libs/workspace-bootstrap/src/hooks.js`)

`HOOK_EVENTS` gains a fourth entry and an `action` discriminator so
`hookSettings` can emit two different command shapes:

```js
export const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', action: 'status', state: 'inprogress', matcher: undefined },
  { event: 'Notification', action: 'status', state: 'question', matcher: 'permission_prompt|idle_prompt' },
  { event: 'Stop', action: 'status', state: 'question', matcher: undefined },
  { event: 'SessionEnd', action: 'session-end', matcher: undefined },
];

export function hookSettings(repo, boardPath, { command = 'ai-workspace' } = {}) {
  const hooks = {};
  for (const { event, action, state, matcher } of HOOK_EVENTS) {
    const cmd = action === 'session-end'
      ? `${command} session-end ${repo} --board ${boardPath}`
      : `${command} status ${repo} ${state} --board ${boardPath} --event ${event}`;
    const group = { hooks: [{ type: 'command', command: cmd }] };
    if (matcher) group.matcher = matcher;
    hooks[event] = [group];
  }
  return { hooks };
}
```

`installHooks` is unchanged (it just writes whatever `hookSettings` returns).
`reconcile.js`'s `flattenHooks`/`hooksMatch` iterate `HOOK_EVENTS` the same
way they do today — adding `SessionEnd` to the list is enough for drift
detection to cover it; repos with the old 3-hook `settings.local.json` are
automatically flagged `repointed` on the next board server start, same
mechanism that already handles CLI-path drift.

## Section 3 — CLI (`apps/workspace/src/main.js`)

Both hook-invoked subcommands read the hook JSON from stdin when present:

```js
async function readHookPayload(stdin) {
  if (stdin.isTTY) return {}; // manual invocation — no JSON piped in
  const raw = await readAll(stdin); // small helper, drains + JSON.parse
  try { return JSON.parse(raw); } catch { return {}; }
}
```

- `runStatus`: reads the payload, uses `payload.session_id ?? 'manual'` as
  the session key. When `hook_event_name === 'UserPromptSubmit'`, it passes
  both `title: payload.prompt` (only takes effect the first time this
  session is seen, per Section 1) and `lastPrompt: payload.prompt` (always
  overwrites) through to `setSessionStatus`. `Notification`/`Stop` calls omit
  `lastPrompt` entirely, so the previous value is preserved. `--event` still
  overrides `lastEvent` for hook-driven calls; manual calls keep defaulting
  to `'manual'`.
- New `runSessionEnd(argv, deps)`: `ai-workspace session-end <repo> --board
  <path>`, reads the same payload, calls `removeSession(boardPath, repo,
  payload.session_id ?? 'manual')`. If there's no `session_id` (manual
  invocation of `session-end`, an unlikely but harmless case), it removes the
  `"manual"` pseudo-session.
- `main()` gains the `session-end` subcommand dispatch alongside `status` and
  `bootstrap`.

## Section 4 — Frontend (`apps/board/src`)

- **`useBoard.js`**: `diffTransitions` walks `repos → sessions` pairs instead
  of top-level repo entries; a transition is `{ repoName, sessionId, title,
  status }`. `questionCount` (in `App.vue`) sums sessions across all repos
  with `status === 'question'`.
- **`App.vue`**: `entriesFor(status)` changes from filtering repos by a
  single `r.status` to, per repo, collecting the sessions whose `status`
  matches the column, and emitting `{ name, sessions }` only when that list
  is non-empty. A repo with no sessions at all still emits one `{ name,
  sessions: [] }` entry into the `todo` column (placeholder card).
- **`Card.vue`**: renders the repo name once, then one `SessionRow.vue` per
  session. The amber "question" ring styling is driven by the column's
  status (already known from context), unchanged in spirit.
- **`SessionRow.vue`** (new): shows `title` (truncated ~60 chars) as a
  heading and relative time via existing `useRelativeTime`, plus
  `lastPrompt` clipped to 140 characters with a local `expanded` ref and a
  "voir plus"/"voir moins" toggle shown only when the full text exceeds 140
  chars. Kept as its own component (rather than inline in `Card.vue`) so
  each row owns its own expand/collapse state independently. The row itself
  is the clickable target for opening `RepoDetail`, emitting `open` with
  `{ name, sessionId }` instead of just `name`.
- **`RepoDetail.vue`**: takes the selected `{ name, sessionId }`, looks up
  that specific session's `events`/`title`/`status` for the history panel,
  instead of the whole repo's flat event list.
- **`SummaryHeader.vue`**: counts are computed over the flattened list of all
  sessions across all repos rather than `Object.values(repos)` directly.
- **`useNotifications.js`**: notification title/body interpolates the
  session's `title` (e.g. `"ai-sync · fix login redirect → question"`)
  instead of just the repo name, so two blocked sessions on the same repo
  produce two distinguishable notifications.

## Section 5 — Testing

Coverage gate is 100% (`CONTRIBUTING.md`); every new branch needs a test.

- **`libs/workspace-bootstrap/test/board.test.js`**: `setSessionStatus`
  creates a new session, updates an existing one without touching sibling
  sessions, sets `title` only on first write and preserves it on later
  writes even when a different `title` is passed; overwrites `lastPrompt`
  every time it's passed and preserves the previous value when it's omitted
  (e.g. `Notification`/`Stop` calls); `removeSession` deletes
  one session and leaves siblings/other repos intact, is a no-op for an
  unknown repo/session; `readBoard` resets a v1-shaped or malformed repo
  entry to `{ sessions: {} }` and bumps `version` to 2; `initRepos` seeds
  `{ sessions: {} }`.
- **`libs/workspace-bootstrap/test/hooks.test.js`**: `hookSettings` emits the
  `session-end` command shape for `SessionEnd` and the existing `status`
  shape for the other three events.
- **`libs/workspace-bootstrap/test/reconcile.test.js`**: drift detection
  flags a checkout still missing the `SessionEnd` hook as `repointed`.
- **`apps/workspace/test/main.test.js`** (or equivalent): `status` with a
  piped `UserPromptSubmit` payload extracts `session_id`/`prompt` correctly
  and forwards both `title` and `lastPrompt`; `status` with a piped
  `Notification`/`Stop` payload forwards neither; `status` with stdin as a
  TTY (manual call) falls back to `"manual"` with no title/lastPrompt; new
  `session-end` subcommand parses argv and calls `removeSession` with the
  piped `session_id`.
- **`apps/board/src/*.test.js`**: `App.test.js` covers a repo with sessions
  in two different statuses appearing in both columns, each showing only its
  own subset; `Card.test.js` covers multi-session rendering;
  `SessionRow.test.js` (new) covers the 140-char clip, the expand/collapse
  toggle only appearing when text overflows, and the `open` emission with
  `{ name, sessionId }`; `useBoard.test.js` covers per-session transition
  diffing; `SummaryHeader.test.js` covers session-level counting;
  `useNotifications.test.js` covers the session-title-bearing notification
  body.

## Out of scope (YAGNI)

- Catching hard kills/crashes that never fire `SessionEnd` — accepted gap,
  matches today's behavior for repos in general.
- Any UI for manually clearing a stuck `"manual"` pseudo-session or a
  session whose `SessionEnd` never fired — can be added later if it turns
  out to matter in practice.
- Reading the transcript file for anything — the hook payload already has
  everything this feature needs.
- A real migration path for existing `board.json` files — treated as
  disposable runtime state per the Decisions section.
