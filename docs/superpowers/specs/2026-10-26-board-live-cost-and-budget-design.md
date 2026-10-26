# Live cost and budget alerts on the board — design

**Date:** 2026-10-26
**Status:** Draft (pending review, then implementation plan)
**Origin:** [Proposal P12](../../proposals/README.md#p12--live-cost-and-budget-alerts-on-the-board)

## Purpose

The board prices tokens in one place: the History page, for sessions that have
already closed. A session that is running — the only one you can still stop —
shows a token count and no money, and nothing warns you when it gets expensive.
This change puts the cost on the live card, makes the pricing table honest about
what it knows, and adds optional budget alerts that reuse the notification
path the board already has.

## Scope

1. **Euro pricing.** `PRICING` stays in USD as Anthropic publishes it; one
   `USD_TO_EUR` constant is applied inside `pricing.js`, so every consumer
   (History charts included) shows euros.
2. **Honest model matching.** An unlisted model id is matched against the table
   by family prefix before falling back to `default`, and a figure that still
   fell back is marked as an estimate.
3. **Live cost.** `costOf(session.usage)` on the session card and in the repo
   detail panel, with a per-model breakdown in the tooltip.
4. **Cache hit rate** on the card tooltip and the detail panel, with a hint when
   it is low.
5. **Budget alerts.** Optional per-session and per-day thresholds, in euros,
   kept in the browser; a browser notification at the threshold and at each
   doubling; the card highlights while over its threshold.

Out of scope: any server or `board.json` change (all of this is computed
client-side from `usage` the board already stores); a network lookup of prices or
of the exchange rate; currencies other than euro; team-wide or shared budgets
(the board is a single-user local tool — see
[Deliberately not proposed](../../proposals/README.md#deliberately-not-proposed));
a "what would this have cost on another model" simulator; repricing Copilot
models (see Open questions).

## Decisions

| Topic | Decision |
|---|---|
| Display currency | Euro, everywhere cost is shown |
| Table currency | USD, as published, so it can be checked against Anthropic's pricing page |
| Conversion | One hand-set `USD_TO_EUR` constant next to `PRICING`, applied in `costByModel` |
| Rate source | Set by hand from a published rate when the table is updated; no network lookup. The initial value is chosen at implementation time, not in this spec |
| Where cost is computed | Client-side, at render time, from raw token counts — a table or rate correction reprices everything, live sessions and history alike |
| Model lookup order | Exact id → longest family prefix on a `-` boundary → `default` |
| Estimate marker | A figure containing any `default`-priced or `unknown` amount renders with a leading `~` and an explanatory tooltip |
| Budget storage | `localStorage` key `maggie:budget`, same convention as `maggie:sound` |
| Budget unit | Euros |
| Alert cadence | At the threshold, then at each doubling (T, 2T, 4T…) |
| Day boundary | The browser's local calendar day |
| Server changes | None |

## Architecture

### `pricing.js` — euro, prefix match, estimate flag

`costForModel` is unchanged except that `costByModel` multiplies each result by
`USD_TO_EUR`. The comment above `PRICING` is corrected from "€/million" to "USD
per million tokens, as published"; the euro conversion is documented next to
`USD_TO_EUR`.

```js
export const USD_TO_EUR = /* set at implementation */;

// Exact id, else the longest key that is a prefix on a '-' boundary
// (claude-sonnet-5-5 → claude-sonnet-5), else null.
export function rateFor(model) { /* … */ }
```

`costByModel` uses `rateFor(model) ?? PRICING.default` and a new
`isEstimate(usage)` helper returns true when any model resolved to the
fallback, or when the usage had no `byModel` and was priced whole under
`unknown`. The prefix rule requires the `-` boundary so `claude-sonnet-5` can
never match a hypothetical `claude-sonnet-50`.

Existing assertions in `pricing.test.js` that pin amounts (e.g. `22.05` for one
million of each counter on Sonnet) become `22.05 * USD_TO_EUR`, written that way
so the test states the relationship instead of a magic number.

### `cache.js` — hit rate

```js
// share of input-side tokens served from cache
export function cacheHitRate(usage) {
  const read = usage?.cacheReadInputTokens ?? 0;
  const total = read + (usage?.cacheCreationInputTokens ?? 0) + (usage?.inputTokens ?? 0);
  return total === 0 ? null : read / total;
}
export const LOW_CACHE_RATE = 0.5;
export const LOW_CACHE_MIN_TOKENS = 50_000;
```

The hint ("low cache hit rate — the prefix may be changing every turn") shows only
when the rate is below `LOW_CACHE_RATE` **and** the input-side total is at least
`LOW_CACHE_MIN_TOKENS`: a session that has barely started has nothing to cache
yet and would otherwise always read as a problem. `null` (no tokens) renders
nothing.

### Display

- **`SessionRow.vue`** — a cost badge beside the existing token badge,
  `~€0.42` or `€0.42` via `formatChartValue(cost, 'cost')` (already
  `toLocaleString` with `currency: 'EUR'`). The existing `usageTooltip` gains the
  per-model breakdown and the cache hit rate. Over its session threshold the
  badge takes a warning style from the theme tokens (not a hardcoded colour — the
  board has four themes and a dark mode).
- **`RepoDetail.vue`** — the same figures per session, plus the cache hint when
  it applies.
- **`SummaryHeader.vue`** — today's total in euros, shown only when a day
  threshold is set, with the threshold, so the number answers "how close am I".
- **Locales** — new keys in `en`, `fr`, `de`, `es`; the locale test already
  fails on a key missing from one language.

### Budget

**Storage and UI.** `maggie:budget` holds `{ "session": number|null,
"day": number|null }`; absent or `null` means off, which is the default. Two
number inputs sit in a collapsed `<details>` in the notification bar next to the
sound toggle, because that is where a user already goes to configure alerts.
Every read and write is wrapped in try/catch and the board renders correctly
without it, as with the sound preference.

**`useBudgetAlerts(sessions, dayTotal, budget, deps)`** follows the shape of
`useNotifications`: dependencies (`notifier`, `playSound`, `storage`) are
injected so it tests without a browser.

- For each live session, `level = cost < T ? 0 : floor(log2(cost / T)) + 1`.
  A notification fires when the level rises above the last level notified for
  that `repo/sessionId`; levels are kept in memory.
- The day total is `Σ costOf(history entries whose endedAt falls on the local
  day) + Σ costOf(live sessions)`, with its own level counter against the day
  threshold.
- **First read after load records the current level without notifying.** A page
  reload while a session is already at 4× must not replay three alerts.
- Permission and sound follow the existing toggles: no notification unless the
  user granted permission; the sound plays only if sound is on.
- Notification text: `<repo> · <title> — €X.XX (threshold €T)`, translated.

**Where history comes from.** The board page does not fetch `/api/history` today
(only the History page does). When a day threshold is set, the board polls it at
the same interval as `/api/board`; with no day threshold nothing is fetched.

**Accepted imprecision.** A live session's `usage` is cumulative since the
session started, so a session spanning midnight counts wholly toward the day it
is running in or closes in. Closing moves a session from the live set into
history, so it is never counted twice. The day figure is an alarm, not an
invoice.

## Error handling

- `usage` is `null` (a session before its first `Stop`): no cost badge, no hint,
  no alert.
- A model id with no match: priced at `default`, shown with `~`.
- `localStorage` unavailable or holding invalid JSON: budget treated as off.
- A non-finite or non-positive threshold typed into an input: ignored, the
  previous value kept.
- `/api/history` unreachable: the day total shows without the closed sessions
  rather than blocking the live figures; the board's existing `connected`
  indicator is not reused for this.

## Testing

The board's front end runs under vitest; the repo's coverage gate applies to the
new modules.

- `pricing.test.js` — prefix match including the `-` boundary and the
  longest-prefix case; fallback and `isEstimate`; amounts expressed through
  `USD_TO_EUR`.
- `cache.test.js` — rate, null, and both sides of the hint's two conditions.
- `useBudgetAlerts.test.js` — below threshold, at threshold, at 2× and 4×, no
  re-notify at the same level, no replay on first read, day total across history
  and live, permission denied, sound on and off, storage throwing.
- `SessionRow.test.js`, `RepoDetail.test.js`, `SummaryHeader.test.js` — the new
  badge, estimate marker, warning state, and absence when `usage` is `null`.
- Locale parity is covered by the existing i18n test.

## Open questions

- **Copilot sessions.** Their counters map onto the same four fields, but the
  models behind them are not Claude's, so they will mostly price at `default` and
  show `~`. That is truthful but not useful. Pricing them properly needs a table
  entry per model Copilot reports; worth deciding once there is real data on
  which models appear.
- **Rate drift.** A hand-set `USD_TO_EUR` goes stale. The UI shows the converted
  figure as indicative; whether to also display the rate in use is left to the
  implementation plan.
- **Per-repo thresholds.** Not included. A single session threshold is the
  smallest thing that catches a runaway; per-repo is additive later.
