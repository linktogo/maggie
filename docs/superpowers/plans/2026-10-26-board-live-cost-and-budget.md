# Live cost and budget alerts on the board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the estimated cost (in euros) of running sessions on the board, make the pricing honest about estimates, and add optional budget alerts.

**Architecture:** Everything is client-side in `apps/board/src`, computed from the `usage` (with `byModel`) the board already stores. `pricing.js` gains a euro conversion and prefix matching; two small pure modules (`cache.js`, `liveUsage.js`) feed the display; a module-level `budget` store and a `useBudgetAlerts` composable reuse the existing notification path.

**Tech Stack:** Vue 3, vitest + `@vue/test-utils` (jsdom), Tailwind theme tokens, hand-rolled i18n (`locales/{en,fr,de,es}.js`).

**Spec:** [docs/superpowers/specs/2026-10-26-board-live-cost-and-budget-design.md](../specs/2026-10-26-board-live-cost-and-budget-design.md)

**Prerequisite:** run `npm ci` at the repo root. Front-end tests run with `cd apps/board && npx vitest run src/<file>.test.js`; the whole front end with `npm run test:board` from the root. Lint: `npm run lint`.

## Global Constraints

- Display currency is euro; `PRICING` stays in USD per million tokens as published; one hand-set `USD_TO_EUR` constant is applied inside `costByModel`.
- No server, `board.json` or API change. No network lookup of prices or rate.
- Model lookup order: exact id → longest key that is a prefix on a `-` boundary → `PRICING.default`. `'default'` is never matched as a model id.
- A figure containing any default-priced or `unknown` amount shows a leading `~` and an explanatory tooltip.
- Cache hint only when hit rate `< 0.5` **and** input-side tokens `>= 50_000`.
- Budget lives in `localStorage` key `maggie:budget` as `{ session: number|null, day: number|null }`, euros, off by default; every storage access in try/catch.
- Alert at the threshold, then at each doubling (T, 2T, 4T…). Day boundary is the browser's local calendar day.
- Colours come from theme tokens (`STATUS_STYLES.question.chip`), never hardcoded; every new string exists in `en`, `fr`, `de`, `es`.
- Commits end with the attribution lines from the session's system reminder.

## Review Focus

- Pricing amounts in existing tests (`pricing.test.js`, `useHistoryStats.test.js`, `HistoryPage.test.js`, chart tests) that pin USD-derived numbers: they must change with `USD_TO_EUR`, expressed through the constant. Pinned in Task 1.
- A model id such as `claude-sonnet-50` or `my-claude-sonnet-5` must not match `claude-sonnet-5`. Pinned in Task 1.
- A session with `usage` present but no `byModel` (pre-migration) is an estimate, not zero. Pinned in Tasks 1 and 3.
- Page reload while a session is already at 4× the threshold must not replay alerts. Pinned in Task 5.
- Local midnight: the day total and its alert level reset without notifying. Pinned in Task 5.
- `localStorage` throwing, or holding invalid JSON, leaves the budget off and the board rendering. Pinned in Task 4.

---

### Task 1: Euro pricing, prefix matching, estimate flag

**Files:**
- Modify: `apps/board/src/pricing.js`
- Test: `apps/board/src/pricing.test.js`
- Modify (if they pin amounts): `apps/board/src/useHistoryStats.test.js`, `apps/board/src/HistoryPage.test.js`, `apps/board/src/chartFormat.test.js`, `apps/board/src/TimeSeriesChart.test.js`, `apps/board/src/ProjectBarChart.test.js`

**Interfaces:**
- Produces:
  - `export const USD_TO_EUR: number` — a published USD→EUR rate chosen at implementation time, with a comment giving the date and source.
  - `export function rateFor(model: string): Rate | null` — `Rate = { input, output, cacheWrite, cacheRead }`.
  - `export function isEstimate(usage: Usage | null): boolean`
  - `costByModel(usage)` and `costOf(usage)` keep their signatures and now return euros.

- [ ] **Step 1: Write the failing tests** in `pricing.test.js`:
  - `rateFor('claude-sonnet-5')` equals `PRICING['claude-sonnet-5']`.
  - `rateFor('claude-sonnet-5-5')` equals `PRICING['claude-sonnet-5']` (prefix on a `-` boundary).
  - `rateFor('claude-haiku-4-5-20251001')` equals its own entry (exact beats prefix).
  - `rateFor('claude-sonnet-50')` is `null`; `rateFor('my-claude-sonnet-5')` is `null`; `rateFor('default')` is `null`; `rateFor('gpt-5')` is `null`.
  - `isEstimate` is `false` for `byModel` containing only known ids, `true` when one id is unknown, `true` for usage with no `byModel`, `false` for `null`.
  - Rewrite the existing `22.05` assertion as `22.05 * USD_TO_EUR` (`toBeCloseTo`, 6 digits), and likewise every other pinned amount in this file.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/pricing.test.js` → FAIL (`rateFor`, `USD_TO_EUR`, `isEstimate` not exported).

- [ ] **Step 3: Implement in `pricing.js`.** Add the three exports above. `costByModel` resolves each model with `rateFor(model) ?? PRICING.default` and multiplies the result of `costForModel` by `USD_TO_EUR`; the no-`byModel` branch does the same under `UNKNOWN_MODEL`. Correct the comment above `PRICING` from "€/million" to "USD per million tokens, as published", and say that euro conversion happens through `USD_TO_EUR`. `rateFor` iterates `Object.keys(PRICING)` excluding `'default'`, accepting `id === key || id.startsWith(key + '-')`, keeping the longest.

- [ ] **Step 4: Run** `cd apps/board && npx vitest run` → find every other test that now fails on a pinned amount, rewrite each assertion through `USD_TO_EUR`, and re-run until the whole front end passes.

- [ ] **Step 5: Commit** `feat(board): price in euros and match model ids by family`.

---

### Task 2: Cache hit rate and the live-usage description

**Files:**
- Create: `apps/board/src/cache.js`, `apps/board/src/liveUsage.js`
- Test: `apps/board/src/cache.test.js`, `apps/board/src/liveUsage.test.js`

**Interfaces:**
- Consumes: `costByModel`, `costOf`, `isEstimate` from `pricing.js` (Task 1).
- Produces:
  - `cache.js`: `export function cacheHitRate(usage): number | null`, `export const LOW_CACHE_RATE = 0.5`, `export const LOW_CACHE_MIN_TOKENS = 50_000`.
  - `liveUsage.js`: `export function describeUsage(usage): null | { cost: number, estimate: boolean, byModel: { model: string, cost: number }[], cacheRate: number | null, lowCache: boolean }` — `null` when `usage` is `null`; `byModel` sorted by cost descending.

- [ ] **Step 1: Write the failing tests.**
  - `cache.test.js`: rate is `read / (read + creation + input)`; `null` for `null` usage and for all-zero usage; read-only usage gives `1`.
  - `liveUsage.test.js`: `describeUsage(null)` is `null`; cost equals `costOf(usage)`; `byModel` sorted descending; `estimate` mirrors `isEstimate`; `lowCache` is `true` for rate `0.2` with 100 000 input-side tokens, `false` for rate `0.2` with 10 000 tokens (too early), `false` for rate `0.9` with 100 000, `false` when the rate is `null`; usage without `byModel` gives `estimate: true` and a single `unknown` entry.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/cache.test.js src/liveUsage.test.js` → FAIL (modules missing).

- [ ] **Step 3: Implement** `cacheHitRate` as in the spec and `describeUsage` composing `costByModel`/`costOf`/`isEstimate`/`cacheHitRate`; `lowCache` is `cacheRate !== null && cacheRate < LOW_CACHE_RATE && inputSideTokens >= LOW_CACHE_MIN_TOKENS`.

- [ ] **Step 4: Run the two files** → PASS.

- [ ] **Step 5: Commit** `feat(board): describe live usage with cost and cache hit rate`.

---

### Task 3: Cost on the session card and in the detail panel

**Files:**
- Modify: `apps/board/src/SessionRow.vue`, `apps/board/src/RepoDetail.vue`
- Modify: `apps/board/src/locales/en.js`, `fr.js`, `de.js`, `es.js`
- Test: `apps/board/src/SessionRow.test.js`, `apps/board/src/RepoDetail.test.js`

**Interfaces:**
- Consumes: `describeUsage` (Task 2); `formatChartValue(value, 'cost')` from `chartFormat.js`.
- Produces: `data-test="cost-badge"` on the card and `data-test="detail-cost"` in the detail panel (Task 6 asserts the warning state on the former).
- New locale keys (all four files): `session.costTooltip` (`Estimated cost by model: {breakdown}`), `session.estimateHint` (`Estimate — at least one model is priced at the default rate`), `session.cacheRate` (`cache hit rate {rate} %`), `session.cacheLow` (`low cache hit rate — the prompt prefix may be changing every turn`).

- [ ] **Step 1: Write the failing tests.**
  - `SessionRow.test.js`: with `usage` including `byModel: { 'claude-sonnet-5': {…1M of each…} }` the `cost-badge` text equals `formatChartValue(22.05 * USD_TO_EUR, 'cost')` with no `~`; with an unknown model the text starts with `~` and its `title` contains the `session.estimateHint` text; with `usage: null` there is no `cost-badge`; with `lowCache` usage the badge `title` contains the `session.cacheLow` text.
  - `RepoDetail.test.js`: a session with usage renders `detail-cost` with the same text rules; without usage it does not render.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/SessionRow.test.js src/RepoDetail.test.js` → the new tests FAIL.

- [ ] **Step 3: Implement.** In `SessionRow.vue` compute `described = describeUsage(usage.value)` and render a `cost-badge` span next to the existing token badge, same classes as it; its `title` joins the per-model breakdown (`session.costTooltip`), the `session.estimateHint` when `estimate`, `session.cacheRate` when the rate is not `null`, and `session.cacheLow` when `lowCache`. The text is `~`-prefixed when `estimate`. Mirror the same figures in `RepoDetail.vue` as a line under the session title. Add the four keys to all four locales (the i18n parity test fails on a missing one).

- [ ] **Step 4: Run** `cd apps/board && npx vitest run src/SessionRow.test.js src/RepoDetail.test.js src/i18n.test.js` → PASS.

- [ ] **Step 5: Commit** `feat(board): show estimated cost and cache hit rate on live sessions`.

---

### Task 4: Budget store

**Files:**
- Create: `apps/board/src/budget.js`
- Test: `apps/board/src/budget.test.js`

**Interfaces:**
- Produces:
  - `export const BUDGET_KEY = 'maggie:budget'`
  - `export function readBudget(storage?: Storage): { session: number | null, day: number | null }` — defaults `globalThis.localStorage`; returns `{ session: null, day: null }` on missing key, invalid JSON, a throwing accessor, or a non-finite / non-positive field (that field becomes `null`).
  - `export const budget: Ref<{ session, day }>` — module-level, initialised from `readBudget()`.
  - `export function setBudget(next: Partial<{ session, day }>, storage?: Storage): void` — a field that is `null` clears it; a field that is not a finite number `> 0` is ignored and the previous value kept; writes `budget.value` to storage inside try/catch.
  - `export function alertLevel(cost: number, threshold: number | null): number` — `0` when `threshold` is `null`/`<= 0` or `cost < threshold`, else `Math.floor(Math.log2(cost / threshold)) + 1`.

- [ ] **Step 1: Write the failing tests:** `readBudget` for empty storage, valid JSON, invalid JSON, a storage whose `getItem` throws, and a negative field; `setBudget` for a valid value, `null` clearing, `NaN`/`0`/`-3`/`'abc'` ignored keeping the previous value, a storage whose `setItem` throws (value still held in `budget`); `alertLevel(0.9, 1) === 0`, `(1, 1) === 1`, `(1.99, 1) === 1`, `(2, 1) === 2`, `(4.5, 1) === 3`, `(5, null) === 0`.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/budget.test.js` → FAIL.

- [ ] **Step 3: Implement** the four exports as specified above.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(board): add the browser-held budget store`.

---

### Task 5: Day total, day history polling, budget alerts

**Files:**
- Create: `apps/board/src/dayCost.js`, `apps/board/src/useDayHistory.js`, `apps/board/src/useBudgetAlerts.js`
- Modify: `apps/board/src/useNotifications.js` (export `defaultPlaySound`)
- Modify: `apps/board/src/locales/{en,fr,de,es}.js`
- Test: `apps/board/src/dayCost.test.js`, `apps/board/src/useDayHistory.test.js`, `apps/board/src/useBudgetAlerts.test.js`

**Interfaces:**
- Consumes: `costOf` (Task 1), `budget`, `alertLevel` (Task 4), `translate` from `i18n.js`, `formatChartValue`.
- Produces:
  - `dayCost.js`: `export function dayTotal(repos: object, entries: HistoryEntry[], now: number): number` — `Σ costOf(entry.usage)` over entries whose `endedAt` falls on the same local calendar day as `now`, plus `Σ costOf(session.usage)` over every live session in `repos`; sessions with `usage: null` count `0`.
  - `useDayHistory.js`: `export function useDayHistory({ fetchImpl, intervalMs, enabled }): { entries: Ref<HistoryEntry[]>, loaded: Ref<boolean> }` — `enabled` is a `Ref<boolean>`; fetches `/api/history` immediately when enabled and then every `intervalMs`; fetches nothing while disabled; clears its timer on unmount; a failed fetch leaves `entries` as they were; `loaded` becomes `true` after the first successful fetch.
  - `useBudgetAlerts.js`: `export function useBudgetAlerts({ repos, dayCost, dayReady, now, permission, soundOn, notifier = globalThis.Notification, playSound = defaultPlaySound }): void`.
  - New locale keys (all four): `budget.sessionAlert` (`{name} · {title} — {cost} (threshold {threshold})`), `budget.dayAlert` (`Today: {cost} (threshold {threshold})`).

Alert rules for `useBudgetAlerts` (the algorithm the tests pin): levels are kept in memory per `repo/sessionId` key. A key seen for the first time records its level **without notifying** (this is the spec's "first read after load" rule applied per session, so a reload never replays alerts). A later level above the recorded one notifies once and records it. Keys no longer present are dropped. The day level starts recording only once `dayReady` is `true` (its first evaluation is silent), is reset silently when the local calendar day of `now` changes, and notifies on a rise like a session. A notification is created only when `permission.value === 'granted'`; `playSound` runs on any alert only when `soundOn.value`. Nothing runs while the relevant threshold is `null`.

- [ ] **Step 1: Write the failing tests.**
  - `dayCost.test.js`: entries ending today and yesterday (local) → only today's counted; live sessions added; `usage: null` ignored; an entry with no `usage` ignored.
  - `useDayHistory.test.js`: disabled → no `fetchImpl` call; enabling → one call then another after `intervalMs` (fake timers); fetch rejection keeps previous entries; `loaded` flips after first success.
  - `useBudgetAlerts.test.js` (fake `notifier` class recording constructions): below threshold → none; first sight of a session already at 4× → none; rise from level 1 to 2 → one notification with the `budget.sessionAlert` text; same level again → none; rise 1→3 in one step → one notification; permission `'denied'` → no notification but sound plays when `soundOn`; sound off → `playSound` not called; session removed then re-added → treated as first sight; threshold `null` → nothing; day: `dayReady` false → nothing and no record, first ready evaluation silent, later rise notifies once with `budget.dayAlert`, local day change resets silently.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/dayCost.test.js src/useDayHistory.test.js src/useBudgetAlerts.test.js` → FAIL (modules missing).

- [ ] **Step 3: Implement** the three modules and export `defaultPlaySound` from `useNotifications.js` (no behaviour change there). `useBudgetAlerts` watches `repos` (deep) and `[dayCost, dayReady, now]`, and reads `budget.value` at evaluation time. Add the two locale keys everywhere.

- [ ] **Step 4: Run the three files plus** `src/useNotifications.test.js src/i18n.test.js` → PASS.

- [ ] **Step 5: Commit** `feat(board): alert when a session or the day crosses its budget`.

---

### Task 6: Wire it into the app

**Files:**
- Create: `apps/board/src/BudgetSettings.vue`
- Modify: `apps/board/src/App.vue`, `apps/board/src/Board.vue`, `apps/board/src/SummaryHeader.vue`, `apps/board/src/SessionRow.vue`
- Modify: `apps/board/src/locales/{en,fr,de,es}.js`
- Modify: `docs/board-dashboard.md`, `docs/proposals/README.md`
- Test: `apps/board/src/BudgetSettings.test.js`, `apps/board/src/SummaryHeader.test.js`, `apps/board/src/SessionRow.test.js`, `apps/board/src/App.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `BudgetSettings.vue`: no props. A `<details data-test="budget-settings">` with two `<input type="number" min="0" step="0.5">`, `data-test="budget-session"` and `data-test="budget-day"`; on `change` it calls `setBudget({ session: value })` / `setBudget({ day: value })`, an empty value passing `null`, and an invalid one leaving `budget` unchanged (Task 4 already ignores it).
  - `SummaryHeader.vue`: new prop `dayCost: { type: Number, default: null }`; renders `data-test="day-cost"` as `summary.today` only when `budget.value.day` is set and `dayCost` is not `null`.
  - `Board.vue`: new prop `dayCost: { type: Number, default: null }`, passed to `SummaryHeader`.
  - New locale keys (all four): `budget.title` (`Budget`), `budget.session` (`Per session (€)`), `budget.day` (`Per day (€)`), `summary.today` (`today {cost} of {threshold}`).

- [ ] **Step 1: Write the failing tests.**
  - `BudgetSettings.test.js`: entering `5` in the session input stores `5` in `budget.value.session`; clearing it stores `null`; entering `-1` leaves the previous value; the day input behaves the same on `budget.value.day`.
  - `SummaryHeader.test.js`: no `day-cost` when `budget.day` is `null`; present with the formatted amounts when set and `dayCost` given.
  - `SessionRow.test.js`: with `budget.session = 1` and a session costing more, the `cost-badge` carries the `STATUS_STYLES.question.chip` classes; below the threshold it does not; with no threshold it does not.
  - `App.test.js`: with a day threshold set, `/api/history` is fetched; with none, it is not (assert on the injected `fetchImpl`).
  Reset `budget` with `setBudget({ session: null, day: null })` in each test's cleanup.

- [ ] **Step 2: Run to verify failure:** `cd apps/board && npx vitest run src/BudgetSettings.test.js src/SummaryHeader.test.js src/SessionRow.test.js src/App.test.js` → the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `SessionRow.vue`: apply the question-chip classes to `cost-badge` when `budget.value.session` is set and `described.cost >= budget.value.session`.
  - `App.vue`: `const dayEnabled = computed(() => budget.value.day !== null)`; `useDayHistory({ fetchImpl, intervalMs: props.intervalMs, enabled: dayEnabled })`; `const dayCostValue = computed(() => dayEnabled.value ? dayTotal(repos.value, entries.value, now.value) : null)`; `useBudgetAlerts({ repos, dayCost: dayCostValue, dayReady: loaded, now, permission, soundOn })`; add `dayCost: dayCostValue.value` to the board's `routeProps`; mount `<BudgetSettings />` beside the sound button.
  - `Board.vue` and `SummaryHeader.vue`: the prop and `day-cost` line described above.
  - Locale keys in all four files.

- [ ] **Step 4: Run** `cd apps/board && npx vitest run` → whole front end PASS; then from the root `npm run lint` and `npm run test:board` → clean.

- [ ] **Step 5: Document.** In `docs/board-dashboard.md` add to "What the UI does": the live cost badge and `~` estimate marker, the cache hint, the budget settings and alert cadence, the note that cost is in euros from a USD table via a hand-set rate, and the day-figure imprecision from the spec. In `docs/proposals/README.md` mark P12 as `Specified` with a link to the spec.

- [ ] **Step 6: Commit** `feat(board): wire live cost, budget settings and alerts into the app`.
