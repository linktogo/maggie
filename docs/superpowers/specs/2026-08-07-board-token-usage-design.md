# Board Token Usage — Design

**Date:** 2026-08-07
**Status:** Approved (pending written-spec review)

## Purpose

The board tracks each Claude Code session's status (`todo`/`inprogress`/`question`/`done`)
but says nothing about how much it costs to run. This feature adds token
consumption to each session card, updated live as the conversation
progresses, and keeps a persistent history of every session's final token
usage once it ends — so past consumption can be reviewed even after the
session's live card disappears from the board.

This builds directly on the session-aware board (`docs/superpowers/specs/2026-08-05-board-multi-session-cards-design.md`):
sessions already carry a stable identity (`session_id`), a title, and a
lifecycle driven by the `UserPromptSubmit` / `Notification` / `Stop` /
`SessionEnd` hooks.

## Decisions (locked during brainstorming)

- **Source of truth: the transcript file, not the hook payload.** None of the
  four hooks carry token counts in their stdin JSON. Every hook payload does
  carry `transcript_path`, a local JSONL file where each assistant turn has a
  `message.usage` object (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`).
  **Correction (found during final review, verified against real local
  transcripts):** Claude Code writes one JSONL line per *content block*
  (`thinking`, `text`, `tool_use`, ...) of a single API response, repeating
  the identical `message.usage` on every one of those lines under the same
  `message.id`. Summing across every `type: "assistant"` line therefore
  overcounts by 65%–160% on real transcripts. Total session usage is the sum
  of those four fields across each **unique `message.id`** (i.e. once per
  API response), not once per line. `readTranscriptUsage` dedupes
  accordingly. Sub-agent (`isSidechain`) turns, if present, are separate API
  responses with their own `message.id` and are naturally included by the
  same dedup logic — though in practice, across this project's local
  transcripts, `isSidechain` is never `true`, so this is unverified in
  practice and sub-agent spend may be recorded elsewhere or not at all.
- **Recomputed on `Stop`, not on every hook.** `Stop` is the only event that
  reliably follows a completed assistant turn; recomputing on
  `UserPromptSubmit`/`Notification` would re-parse the transcript for no new
  data. This mirrors the existing "recompute status on the events that
  actually change something" pattern.
- **Kept as separate input/output/cache-creation/cache-read counts**, not
  collapsed into one number at write time — cache reads are far cheaper than
  fresh input tokens, and collapsing now would make a future cost estimate
  impossible without re-deriving it from raw transcripts.
- **No $ cost estimate in this iteration.** Pricing varies by model, and the
  transcript doesn't reliably identify which model served every turn. Only
  token counts are stored/shown; a cost layer can be added later on top of
  the same `usage` shape without a data migration.
- **Board server does no computation, as today.** `GET /api/board` and the
  new `GET /api/history` both pass their backing files through unchanged;
  all parsing happens once, in the CLI, at hook time.
- **`board.json` stays live/disposable; `history.jsonl` is the permanent
  record.** A session's `usage` on the board is live and disappears with the
  session on `SessionEnd` (`board.json`'s existing disposable-state
  contract, per the multi-session-cards spec, is unchanged). Immediately
  before removal, `SessionEnd` appends one finalized record to
  `history.jsonl` — a new, permanent, append-only file living next to
  `board.json` in the same directory (path derived automatically; no new CLI
  flag or env var).
- **JSONL over a single JSON array for history.** Ending a session is just
  `appendFile` of one line — no read-modify-write, no race between two
  sessions ending at the same moment, unlike the atomic-rename read-modify-
  write `board.json` already needs for its frequently-mutated live state.
- **`startedAt` is a new session field**, set once on a session's first
  board write and never overwritten — same "set once" pattern `title`
  already uses. It exists purely to give history entries a start time (for
  duration), since nothing currently records when a session began.

## Architecture overview

```text
Claude Code hook fires (UserPromptSubmit | Notification | Stop | SessionEnd)
  │  stdin: { session_id, transcript_path, cwd, hook_event_name, prompt?, ... }
  ▼
ai-workspace status <repo> <state> --board <path> --event <name>     (existing)
ai-workspace session-end <repo> --board <path>                       (existing)
  │
  ├─ status (event=Stop only): readTranscriptUsage(transcript_path) → usage
  │     └─ setSessionStatus(..., { usage, ...existing opts })
  ├─ session-end: read board → grab {title, startedAt} for this session
  │     ├─ readTranscriptUsage(transcript_path) (fallback: session's last usage)
  │     ├─ appendHistoryEntry(history.jsonl, {repo, sessionId, title,
  │     │     startedAt, endedAt, usage})
  │     └─ removeSession(boardPath, repo, sessionId)   (unchanged)
  │
  ▼
board.json   { sessions: { <id>: { ..., startedAt, usage } } }   (live, disposable)
history.jsonl  {repo, sessionId, title, startedAt, endedAt, usage}\n...  (permanent)
  │
  ▼
GET /api/board     (unchanged passthrough)
GET /api/history    (new — passthrough, parses each JSONL line)
  │
  ▼
apps/board/src (Vue)
  SessionRow.vue   — token badge (total) + breakdown tooltip, shown once usage exists
  formatTokens.js  — compact number formatting (36420 → "36.4K")
  HistoryView.vue  — new: table of ended sessions, client-side sort/filter
  App.vue          — Board/Historique toggle (local ref, no router)
```

## Section 1 — Token extraction (`libs/workspace-bootstrap/src/tokens.js`, new)

```js
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

export async function readTranscriptUsage(transcriptPath, { read = readFile } = {}) {
  let raw;
  try {
    raw = await read(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY_USAGE };
  }
  const totals = { ...EMPTY_USAGE };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) continue;
    totals.inputTokens += usage.input_tokens ?? 0;
    totals.outputTokens += usage.output_tokens ?? 0;
    totals.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    totals.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  }
  return totals;
}

export function resolveHistoryPath(boardPath) {
  return path.join(path.dirname(boardPath), 'history.jsonl');
}

export async function appendHistoryEntry(historyPath, entry, opts = {}) {
  const { append = appendFile, ensureDir = mkdir } = opts;
  await ensureDir(path.dirname(historyPath), { recursive: true });
  await append(historyPath, `${JSON.stringify(entry)}\n`);
}
```

- A missing or unreadable transcript file returns zeros rather than
  throwing — a `Stop`/`SessionEnd` hook must never fail the CLI call over a
  usage-reporting concern.
- Malformed individual JSONL lines (partial writes, mid-compaction) are
  skipped, not fatal — same tolerance philosophy as `readBoard`'s handling
  of a malformed board file.

## Section 2 — `board.js` (`libs/workspace-bootstrap/src/board.js`)

Only `setSessionStatus` changes, extending the existing "set once" /
"overwrite when passed, else preserve" patterns already used for
`title`/`lastPrompt`:

```js
export async function setSessionStatus(boardPath, repo, sessionId, state, opts = {}) {
  const { lastEvent = 'manual', title, lastPrompt, usage, startedAt, now = () => new Date().toISOString(), ...io } = opts;
  if (!STATES.includes(state)) throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  const board = await readBoard(boardPath, io);
  const at = now();
  const repoEntry = board.repos[repo] ?? { sessions: {} };
  const prevSession = repoEntry.sessions[sessionId];
  const events = [{ event: lastEvent, at }, ...(prevSession?.events ?? [])].slice(0, MAX_EVENTS);
  repoEntry.sessions[sessionId] = {
    status: state,
    updatedAt: at,
    lastEvent,
    title: prevSession?.title ?? title ?? null,
    lastPrompt: lastPrompt ?? prevSession?.lastPrompt ?? null,
    startedAt: prevSession?.startedAt ?? startedAt ?? at,        // NEW — set once
    usage: usage ?? prevSession?.usage ?? null,                  // NEW — overwritten on Stop
    events,
  };
  board.repos[repo] = repoEntry;
  await writeBoard(boardPath, board, io);
  return board;
}
```

`readBoard`, `writeBoard`, `removeSession`, `initRepos` are unchanged.

## Section 3 — CLI (`apps/workspace/src/main.js`)

```js
import { readTranscriptUsage, resolveHistoryPath, appendHistoryEntry } from '@linktogo/ai-workspace-bootstrap';
// (alongside the existing setSessionStatus/removeSession/readBoard imports)
```

- **`runStatus`**: when `payload.hook_event_name === 'Stop'` and
  `payload.transcript_path` is a string, call `readTranscriptUsage` and pass
  the result as `opts.usage` to `setSessionStatus`. `UserPromptSubmit` and
  `Notification` calls don't touch `usage` at all, so the previously
  computed value is preserved (same mechanism `lastPrompt` already relies
  on).
- **`runSessionEnd`**: before calling `removeSession`,
  1. `readBoard(boardPath)` and look up
     `board.repos[repo]?.sessions[sessionId]` for its `title`/`startedAt`.
  2. Compute final `usage`: `readTranscriptUsage(payload.transcript_path)`
     if a transcript path was piped, else fall back to the session's
     already-stored `usage` (or the zeroed default if there's no prior
     session record at all — e.g. a stray `SessionEnd` with no matching
     session).
  3. If a session record was found, `appendHistoryEntry(resolveHistoryPath(boardPath), { repo, sessionId, title, startedAt, endedAt: <now>, usage })`.
     No session found → skip the history write entirely (nothing meaningful
     to record).
  4. Call `removeSession(boardPath, repo, sessionId)`, unchanged.

## Section 4 — Board server (`apps/board/server.js`)

New route, same tolerance pattern as `serveBoard`:

```js
async function serveHistory(historyPath, res) {
  let raw;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    raw = '';
  }
  const entries = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(entries));
}
```

`createBoardServer` routes `GET /api/history` to it, deriving the path with
`resolveHistoryPath(boardPath)`. No new CLI flags — the server already
resolves `boardPath` once at startup.

## Section 5 — Frontend (`apps/board/src`)

- **`formatTokens.js`** (new): `formatTokens(n)` → compact display string
  (e.g. `36420` → `"36.4K"`, `900` → `"900"`, `1_200_000` → `"1.2M"`). Pure
  function, no Vue dependency.
- **`SessionRow.vue`**: when `session.usage` is present, renders a small
  badge next to the relative time showing
  `formatTokens(total)` where `total` sums the four usage fields, with a
  native `title` tooltip attribute spelling out the four-way breakdown
  (input/output/cache-creation/cache-read). No badge at all before the
  first `Stop` (i.e. `usage` still `null`).
- **`HistoryView.vue`** (new): fetches `/api/history` on mount, renders a
  table — repo, title, started, ended, duration, the four token columns,
  and a total column. Client-side only: clicking a column header sorts by
  it (toggling asc/desc), a text input filters rows by repo name. No
  pagination, no server-side query params.
- **`App.vue`**: a small local `view` ref (`'board' | 'history'`) toggled by
  two buttons/tabs in the header bar (next to the existing notification
  toggles), swapping between the existing kanban grid and `HistoryView`.
  No router dependency — the app has none today and two top-level views
  don't justify adding one.

## Section 6 — Testing

Coverage gate is 100% (`CONTRIBUTING.md`); every new branch needs a test.

- **`libs/workspace-bootstrap/test/tokens.test.js`** (new): `readTranscriptUsage`
  sums `message.usage` across `assistant`-typed lines including sidechain
  ones, skips non-assistant lines and lines without `usage`, skips malformed
  JSON lines, returns zeroed totals for a missing file; `resolveHistoryPath`
  derives the sibling path; `appendHistoryEntry` ensures the directory and
  appends one JSON line per call (multiple calls produce multiple lines).
- **`libs/workspace-bootstrap/test/board.test.js`**: `setSessionStatus` sets
  `startedAt` only on first write and preserves it afterwards; overwrites
  `usage` when passed and preserves the previous value when omitted;
  defaults `startedAt` to the current write's timestamp when a session is
  brand new.
- **`apps/workspace/test/main.test.js`**: `status` with a piped `Stop`
  payload computes usage from the transcript and forwards it;
  `status` with `UserPromptSubmit`/`Notification` payloads don't forward a
  `usage` key at all; `session-end` reads the outgoing session's
  `title`/`startedAt` off the board, computes final usage from the
  transcript, and appends a matching history entry before removing the
  session; `session-end` falls back to the session's last known `usage`
  when no transcript path is piped; `session-end` for an unknown
  repo/session skips the history write but still calls `removeSession`.
- **`apps/board/server.test.js`**: `GET /api/history` returns the parsed
  entries from an existing `history.jsonl`; returns `[]` when the file is
  missing.
- **`apps/board/src/formatTokens.test.js`** (new): formats sub-1000 values
  as-is, thousands with one decimal + `K`, millions with one decimal + `M`.
- **`apps/board/src/SessionRow.test.js`**: renders the token badge with the
  formatted total and a tooltip containing the breakdown when `usage` is
  present; renders no badge when `usage` is `null`.
- **`apps/board/src/HistoryView.test.js`** (new): renders one row per
  fetched entry; sorting by a column header reorders rows; filtering by
  repo name hides non-matching rows.
- **`apps/board/src/App.test.js`**: toggling the view switches between the
  kanban grid and `HistoryView`.

## Out of scope (YAGNI)

- Dollar-cost estimation — token counts only; a pricing layer can be
  layered on the same `usage` shape later.
- Aggregation/rollups (per day, per repo, totals across sessions) — the raw
  history table with client-side sort/filter covers the current need.
- Pagination or rotation of `history.jsonl` — no volume concern at
  team-board scale.
- Recovering usage for a session killed without a `SessionEnd` firing
  (crash) — same accepted gap as the rest of session lifecycle tracking.
- Editing or deleting history entries.
