# Dashboard improvements — design

**Date:** 2026-06-21
**Status:** Approved (pending implementation plan)

## Purpose

Improve the read-only kanban dashboard (`apps/board/`) so it better serves its
core job: **watching AI agents work across repos**. The `question` status means
an agent is blocked waiting for human input — the dashboard should shorten the
delay between "an agent needs you" and "you know it". Polling of `board.json` is
retained (no SSE).

## Scope

Three feature groups, selected by the user:

- **A — Attention alerts:** browser notifications + optional sound, tab-title
  badge, visual highlight of `question` cards.
- **C — Readability:** relative time, summary header (counts + progress bar),
  search/filter by repo name and technology/target.
- **D — Enriched context:** repo URL link + technology/target filter (from
  `repos.json`), and per-repo **event history** (requires a `board.json` schema
  extension).

Out of scope: SSE/real-time transport, drag-and-drop status edits (board stays
read-only), i18n (tracked separately), dark mode, mobile layout.

## Decisions

| Topic | Decision |
|---|---|
| Notification triggers | A repo transitioning **into** `question` **or** `done` |
| First load | Establishes baseline snapshot — **no** notifications fired |
| Sound | Toggle, **off by default**, persisted in `localStorage` |
| Title badge | `(n) ai-sync board`, n = repos currently in `question` |
| Detail presentation | **Right side panel** (board stays visible), close on Esc / outside click |
| Event history bound | Keep last **20** events per repo |
| Config delivery | Separate `GET /api/config` endpoint, fetched **once** on load |
| Config absent | Endpoint returns `{ repos: {} }`; board runs degraded (no links/techno filter) |

## Architecture

### Data model — `board.json` (additive change)

The `version` field stays `1`: the change is purely additive and
backward-compatible. Each repo entry gains a bounded `events` array, and
existing fields are kept:

```json
{
  "version": 1,
  "repos": {
    "oc-auth": {
      "status": "question",
      "updatedAt": "2026-06-21T10:00:12.000Z",
      "lastEvent": "waiting input",
      "events": [
        { "event": "waiting input", "at": "2026-06-21T10:00:12.000Z" },
        { "event": "edit src/",     "at": "2026-06-21T09:57:00.000Z" },
        { "event": "cloned",        "at": "2026-06-21T09:52:00.000Z" }
      ]
    }
  }
}
```

- `lastEvent` is maintained as `events[0].event` (newest first).
- `events` is capped at 20 entries (newest kept).

### `src/board.js` (coverage gate: 100% lines/branches/funcs)

- `setStatus` / `initRepos`: unshift a `{ event, at }` entry, set `lastEvent`,
  truncate `events` to 20.
- `readBoard`: when an old file has no `events`, **backfill** a single-entry
  array from `lastEvent`/`updatedAt` so consumers always see `events`. No file
  regeneration needed (transparent migration).
- Keep the existing atomic write (tmp + rename) and injected-IO test seams.

### Server — `apps/board/server.js` (zero-dependency)

- New optional source for repo config: `--config <repos.json>` flag and
  `AI_SYNC_CONFIG` env var (mirrors the existing `--board`/`AI_SYNC_BOARD`).
- New endpoint **`GET /api/config`** → `{ repos: { <name>: { url, technologies, targets } } }`,
  derived from the parsed config. Without a config source it returns
  `{ repos: {} }`.
- `/api/board` is unchanged and remains the polled endpoint.
- Path-traversal guard and SPA fallback unchanged.

### Front-end — composables (isolated, testable)

- **`useBoard.js`** (extended): retain previous snapshot; expose `transitions`
  (repos that entered `question`/`done` since last poll) and connection/freshness
  state (`lastFetchOk`, `lastFetchAt`). First successful fetch sets the baseline
  and yields **no** transitions.
- **`useConfig.js`** (new): fetch `/api/config` once; expose `repos`
  (url/technologies/targets). Fetch failure → empty config (degraded mode).
- **`useNotifications.js`** (new): permission request via the 🔔 control
  (`Notification.requestPermission()`); on qualifying transitions fire
  `new Notification(...)`; play a sound when the toggle is on (off by default,
  persisted); update `document.title` badge to the `question` count.
  Permission states: default / granted / denied (denied → in-app fallback banner).
- **`useRelativeTime.js`** (new): format ISO timestamps as "il y a 12 s"; a
  shared ticker refreshes rendered values.

### Front-end — components

- **`SummaryHeader.vue`**: per-status counts + progress bar (% `done`).
- **`FilterBar.vue`**: name search input + technology/target select (from
  config). Filter state lifted to `App.vue`.
- **`RepoDetail.vue`**: right side panel — repo URL link, technology/target
  chips, event timeline. Opens on card click; closes on Esc / outside click.
- **`Card.vue`** (extended): relative time; highlight when `status === 'question'`;
  click opens the detail panel.
- **`App.vue`**: composes header + filter bar + columns + detail panel; applies
  filtering.

## Data flow

1. Poll `board.json` → `useBoard` diffs snapshots → `transitions` →
   `useNotifications` (OS notification + title badge + optional sound) and render.
2. `GET /api/config` once → `useConfig` → powers URL links, technology filter,
   and detail-panel metadata.

## Error handling

- `/api/config` unavailable → silent degraded mode (no links / techno filter);
  board stays functional.
- Notification permission denied → discreet in-app banner; board continues.
- Poll failure → "disconnected" freshness indicator; recovers on next poll.

## Testing

- **`src/board.js`** (node:test, 100% gate): event push, truncation at 20,
  `events` backfill from `lastEvent` for legacy files.
- **Server** (node:test): `/api/config` with and without a config source.
- **Front-end** (vitest):
  - `useBoard` transition diff (baseline on first load, detects into-question/done)
  - `useNotifications` (mock `Notification` + permission states, title badge, sound toggle persistence)
  - `SummaryHeader` (counts + percentage)
  - `FilterBar` (name + technology filtering)
  - `RepoDetail` (timeline render + Esc/outside close)
  - `useRelativeTime` (formatting + ticker)

## Implementation order (3 lots)

1. **Data:** `board.json` v2 + `src/board.js` + `/api/config` endpoint.
2. **Readability (C):** relative time, `SummaryHeader`, `FilterBar`.
3. **Alerts (A) + Detail (D):** `useNotifications`, badge/sound, `RepoDetail`
   side panel, `question` highlight.
