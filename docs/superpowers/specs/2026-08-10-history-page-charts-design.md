# History page revamp — design

**Date:** 2026-08-10
**Status:** Approved (pending implementation plan)

## Purpose

The "Historique" tab (`apps/board/`) currently shows a single sortable table
of finished sessions (`GET /api/history` → `history.jsonl`). It has no
dedicated URL, and no way to see consumption trends over time or compare
projects at a glance. This revamp gives history its own route and adds two
consumption charts (over time, and by project), while keeping the existing
detailed table.

## Scope

- Dedicated route `/history` (client-side routing via `vue-router`), separate
  from the board's `/`.
- Time-series chart: consumption bucketed by **day/week/month/year**
  (user-selectable granularity), stacked by token type (input/output/cache
  write/cache read).
- Per-project chart: total consumption by repo, over the same time window as
  the time-series chart's selected period.
- A **Tokens ⇄ €** toggle that switches both charts (and only the charts —
  the detail table keeps its existing token columns) between raw token counts
  and an estimated cost in €.
- Model tracking per message, so cost can be computed per model instead of a
  single blended rate.

Out of scope: a cost column in the detail table, historical backfill of
model data for the 17 pre-migration `history.jsonl` entries, server-side
aggregation endpoints (all bucketing/cost math happens client-side from the
existing `/api/history` payload), non-€ currencies.

## Decisions

| Topic | Decision |
|---|---|
| Consumption metric | Both tokens and estimated €, via a toggle |
| Cost basis | Per-model pricing table, keyed by `message.model` captured per assistant turn |
| Pricing entries with no model (legacy history) | Bucketed under a "modèle inconnu" segment priced at a `default` fallback rate, never silently dropped |
| Cost calculation location | Client-side, computed at render time from raw `byModel` token counts — a pricing update recalculates the entire history immediately, nothing is frozen at write time |
| Detail table | Kept as-is, unchanged, rendered below the charts |
| Route path | `/history` (matches existing English API/code; UI copy stays French) |
| Chart/project time window | The project chart respects the same period as the currently selected time-series bucket |
| Layout | Tabs — **Par période** / **Par projet** — one chart visible at a time, table always visible below |
| Router | `vue-router` (`createWebHistory`) — the server already SPA-falls-back to `index.html` for unknown paths, so `/history` survives a reload with no server change |
| Chart library | Chart.js, wrapped in two thin Vue components (no third-party Vue chart wrapper) |

## Architecture

### Data pipeline — model-aware token tracking

**`libs/workspace-bootstrap/src/tokens.js` — `readTranscriptUsage`**

Every transcript line already exposes `message.model` alongside
`message.usage`. Extend the aggregation to break totals down per model (a
session can span multiple models if the user switches mid-session):

```js
{
  inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, // unchanged, still the grand total
  byModel: {
    "claude-sonnet-5": { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
    "claude-opus-5": { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
  },
}
```

**`libs/workspace-bootstrap/src/board.js`**

`session.usage` and the entry written by `closeSession` (and by
`apps/workspace/src/main.js:runSessionEnd`, which also calls
`readTranscriptUsage` independently) carry `byModel` through unchanged —
pure plumbing, no aggregation logic here.

**`history.jsonl` schema (additive)**

```json
{"repo":"ai-sync","sessionId":"...","title":"...","startedAt":null,"endedAt":"...",
 "usage":{"inputTokens":1653,"outputTokens":194274,"cacheCreationInputTokens":1066789,"cacheReadInputTokens":25276876,
          "byModel":{"claude-sonnet-5":{"inputTokens":1653,"outputTokens":194274,"cacheCreationInputTokens":1066789,"cacheReadInputTokens":25276876}}}}
```

Entries written before this change have no `byModel` — treated as "modèle
inconnu" wherever cost is computed (see Decisions).

### Pricing — `apps/board/src/pricing.js`

Static table, €/million tokens, manually maintained (no network fetch):

```js
export const PRICING = {
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-opus-5':   { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
  default:           { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
};

export function costOf(byModel) { /* sums each model's tokens × its rate, falling back to `default` */ }
```

`costOf` is a pure function consumed client-side — nothing about pricing
touches the server or `history.jsonl`.

### Routing

`vue-router` added as a dependency. `App.vue` drops its `view = ref('board')`
toggle in favor of two routes:

- `/` → `Board.vue` (today's board content: `SummaryHeader`, `FilterBar`,
  columns, `RepoDetail` — extracted from `App.vue` as-is, no behavior change)
- `/history` → `HistoryPage.vue`

The header's Board/Historique switcher becomes `<router-link>`s, same visual
styling as today's buttons. No server change: `apps/board/server.js`
already serves `index.html` for any unrecognized path.

### `HistoryPage.vue`

- Header: **Tokens ⇄ €** toggle (local `ref`, not persisted).
- Tabs: **Par période** / **Par projet** (`aria`-accessible tab pattern,
  matches the existing Board/Historique tab styling in `App.vue`).
  - **Par période**: granularity selector (Jour/Semaine/Mois/Année) +
    `TimeSeriesChart` — stacked bars, one segment per token type (tokens
    mode) or per model + "modèle inconnu" (€ mode).
  - **Par projet**: `ProjectBarChart` — horizontal bars, one per repo,
    sorted descending, scoped to the period currently selected in the other
    tab (so switching tabs doesn't need re-deriving a separate window).
- `HistoryTable.vue` (renamed from today's `HistoryView.vue`, logic
  unchanged) always rendered below the tabs.

### `useHistoryStats.js` (new composable)

Pure client-side aggregation over the entries already fetched by
`useHistory` — no new API endpoint:

- `bucketByPeriod(entries, granularity)` → time-ordered buckets, each with
  token totals by type and `byModel` cost inputs. Entries are bucketed by
  `endedAt` (the only timestamp guaranteed present — many entries have
  `startedAt: null` today, same as `HistoryView.vue`'s existing sort
  behavior). Bucketing uses the browser's local timezone.
- `totalsByProject(entries)` → totals per repo, sorted descending.

Both accept the same `entries` array `HistoryTable.vue` already renders, so
data stays in sync without a second fetch.

## Data flow

1. `useHistory` fetches `/api/history` once (as today, on tab open).
2. `HistoryPage.vue` feeds those entries into `useHistoryStats`, which
   derives the two chart datasets reactively as granularity/tab/€-toggle
   change — all client-side, no extra network round-trip.
3. `TimeSeriesChart` / `ProjectBarChart` render token or € values depending
   on the toggle, using `pricing.js#costOf` for the € path.

## Error handling / edge cases

- No `startedAt` on an entry → bucketed by `endedAt` only (matches current
  table behavior, not a regression).
- No `byModel` on an entry (pre-migration data) → tokens display normally;
  € mode shows a distinct "modèle inconnu" segment priced at `default`
  rather than silently omitting or mispricing the entry.
- No sessions in the selected period → same empty state copy as today
  ("Aucune session terminée pour l'instant.").
- `/api/history` fetch failure → unchanged existing behavior (`useHistory`
  already falls back to `entries.value = []`).

## Testing

- `readTranscriptUsage.test.js` (extend): `byModel` breakdown from a
  multi-model transcript fixture.
- `pricing.test.js` (new): `costOf` against known `byModel` inputs,
  including the `default` fallback path.
- `useHistoryStats.test.js` (new): bucketing per granularity (day/week/
  month/year boundaries), `endedAt`-only entries, project totals ordering.
- `HistoryPage.test.js` (new): tab switching, toggle wiring, granularity
  selector.
- `TimeSeriesChart.test.js` / `ProjectBarChart.test.js` (new): mount/props
  smoke tests — no canvas pixel assertions.
- `HistoryTable.test.js` (renamed from `HistoryView.test.js`): unchanged
  assertions.
- `App.test.js` (update): route-based navigation replaces the `view` ref
  assertions.

## Implementation order (3 lots)

1. **Data:** `byModel` capture in `readTranscriptUsage`, plumbed through
   `board.js`/`main.js` into `history.jsonl`; `pricing.js` + `costOf`.
2. **Routing:** `vue-router` setup, `Board.vue` extraction, `/history` route,
   `HistoryTable.vue` rename — page reachable and behaviorally identical to
   today's tab, just at its own URL.
3. **Charts:** `useHistoryStats`, `TimeSeriesChart`, `ProjectBarChart`,
   `HistoryPage.vue` tabs and Tokens⇄€ toggle.
