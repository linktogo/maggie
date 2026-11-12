# History Page Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the board's "Historique" tab its own `/history` route, and add
consumption charts (by day/week/month/year, and by project) with a Tokens ⇄ €
toggle, on top of the existing detail table.

**Architecture:** `readTranscriptUsage` (libs/workspace-bootstrap) starts
attributing token usage to the `message.model` that produced it, so
`history.jsonl` carries a per-model breakdown. `apps/board` gets a pure
client-side pricing module that turns that breakdown into an € estimate, a
`vue-router`-based `/history` route (the board's own view is extracted into
`Board.vue` first, as a behavior-preserving refactor), a `useHistoryStats`
composable that buckets/aggregates the already-fetched history entries, and
two thin Chart.js wrapper components consumed by a tabbed `HistoryPage.vue`.
No new API endpoint — everything past `GET /api/history` is client-side.

**Tech Stack:** Vue 3 (`<script setup>`), `vue-router` 4.x, `chart.js` 4.x,
Vitest + `@vue/test-utils` (apps/board), `node:test` (libs/workspace-bootstrap).

**Spec:** `docs/superpowers/specs/2026-08-10-history-page-charts-design.md`

---

## Before you start

**Use `vue-router@^4.6.0`, not the `latest` tag.** `npm view vue-router
version` currently resolves to `5.2.0`, but v5 is a different architecture —
its `peerDependencies` pull in `pinia`, `@pinia/colada`, and a Vite
plugin/compiler toolchain (`unplugin`, `chokidar`, `@vue-macros/common`,
`magic-string`...), none of which this two-route addition needs. v4.6.4 (the
latest 4.x) peer-depends on nothing but `vue: ^3.5.0`, which is exactly what
`apps/board` already runs, and is the classic `createRouter({ history, routes
})` / `<router-link>` / `<router-view>` API this plan is written against. If
`npm install vue-router` is ever run without a version pin here, it will
install v5 and nothing in this plan will work as written.

## File structure

New files:
- `apps/board/src/pricing.js` + `pricing.test.js` — €/million-token rates and `costByModel`/`costOf`
- `apps/board/src/Board.vue` — today's board view (columns, filters, detail panel), extracted from `App.vue`
- `apps/board/src/router.js` — the two-route `vue-router` instance
- `apps/board/src/HistoryPage.vue` — route component for `/history`: tabs, Tokens⇄€ toggle, both charts, the table
- `apps/board/src/useHistoryStats.js` + test — client-side bucketing (by period) and aggregation (by project)
- `apps/board/src/TimeSeriesChart.vue` + test — stacked bar chart, one bar per period bucket
- `apps/board/src/ProjectBarChart.vue` + test — horizontal bar chart, one bar per repo

Renamed files:
- `apps/board/src/HistoryView.vue` → `HistoryTable.vue` (content unchanged — it's just the detail table now, embedded in `HistoryPage.vue` instead of being the whole tab)
- `apps/board/src/HistoryView.test.js` → `HistoryTable.test.js`

Modified files:
- `libs/workspace-bootstrap/src/tokens.js` — `readTranscriptUsage` gains a `byModel` breakdown
- `libs/workspace-bootstrap/test/tokens.test.js` — every existing assertion updated for the new `byModel` field, plus new multi-model tests
- `apps/board/src/App.vue` — becomes the router shell (top bar + notifications), delegates view content to `<router-view>`
- `apps/board/src/App.test.js` — mounts with a real (memory-history) router; adds a deep-link test for `/history`
- `apps/board/src/main.js` — installs the router
- `apps/board/package.json` — adds `vue-router` and `chart.js`
- `CHANGELOG.md` — new `Unreleased` bullet

Untouched (confirmed while researching this plan): `libs/workspace-bootstrap/src/board.js`, its test file, and `apps/workspace/src/main.js` all treat `usage` as opaque data they pass through — the new `byModel` field flows through them with no code change.

---

## Task 1: Track token usage per model in `readTranscriptUsage`

A session's turns can span more than one model (the user can switch
mid-session), so usage is attributed per turn rather than tagging the whole
session with one model name. `entry.message.model` is present on every
`type: 'assistant'` transcript line (verified against a real Claude Code
transcript file) alongside `entry.message.usage`.

**Files:**
- Modify: `libs/workspace-bootstrap/src/tokens.js`
- Test: `libs/workspace-bootstrap/test/tokens.test.js`

- [ ] **Step 1: Replace the test file with the updated assertions**

Every existing test's expected object gains a `byModel: {}` key (no fixture
here tags `message.model`, so nothing attributes to it), and three new tests
cover the attribution itself. Overwrite the whole file:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readTranscriptUsage, resolveHistoryPath, appendHistoryEntry } from '../src/tokens.js';

test('readTranscriptUsage sums usage across assistant lines, including sidechain turns', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 22, cacheCreationInputTokens: 33, cacheReadInputTokens: 44, byModel: {} });
});

test('readTranscriptUsage counts usage from a repeated message.id only once', async () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', usage: { input_tokens: 2, output_tokens: 138, cache_creation_input_tokens: 12942, cache_read_input_tokens: 19608 } },
  });
  const lines = [line, line, line].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 2, outputTokens: 138, cacheCreationInputTokens: 12942, cacheReadInputTokens: 19608, byModel: {} });
});

test('readTranscriptUsage sums usage from distinct message.id values', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_2', usage: { input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 2, cache_read_input_tokens: 2 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 3, outputTokens: 3, cacheCreationInputTokens: 3, cacheReadInputTokens: 3, byModel: {} });
});

test('readTranscriptUsage skips non-assistant lines and assistant lines without usage', async () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage skips malformed JSON lines and blank lines', async () => {
  const lines = [
    '{not json',
    '',
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
  ].join('\n');
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1, byModel: {} });
});

test('readTranscriptUsage returns zeroed totals and an empty byModel when the file cannot be read', async () => {
  const usage = await readTranscriptUsage('/missing.jsonl', { read: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('resolveHistoryPath derives history.jsonl next to the board file', () => {
  assert.equal(resolveHistoryPath('/ws/.ai-sync/board.json'), path.join('/ws/.ai-sync', 'history.jsonl'));
});

test('appendHistoryEntry ensures the directory and appends one JSON line per call', async () => {
  const calls = [];
  await appendHistoryEntry('/d/history.jsonl', { a: 1 }, {
    ensureDir: async (dir, opts) => calls.push(['ensureDir', dir, opts]),
    append: async (file, data) => calls.push(['append', file, data]),
  });
  assert.deepEqual(calls, [
    ['ensureDir', '/d', { recursive: true }],
    ['append', '/d/history.jsonl', '{"a":1}\n'],
  ]);
});

test('readTranscriptUsage handles assistant entries with undefined message', async () => {
  const lines = JSON.stringify({ type: 'assistant' }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage handles entries with all token types at zero', async () => {
  const lines = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage handles usage objects with missing token properties', async () => {
  const lines = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 1, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage handles assistant entries with null message', async () => {
  const lines = JSON.stringify({ type: 'assistant', message: null }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage returns empty usage for blank input', async () => {
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => '\n\n\n' });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage correctly handles sidechain flag in assistant entries', async () => {
  const lines = JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 15, cache_read_input_tokens: 20 } } }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 10, cacheCreationInputTokens: 15, cacheReadInputTokens: 20, byModel: {} });
});

test('readTranscriptUsage accumulates multiple entries correctly', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
    '',
    '{invalid}',
    JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
  ].join('\n');
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 2, outputTokens: 3, cacheCreationInputTokens: 4, cacheReadInputTokens: 5, byModel: {} });
});

test('readTranscriptUsage handles usage object with no token properties (all nullish)', async () => {
  const lines = JSON.stringify({ type: 'assistant', message: { usage: {} } }) + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: {} });
});

test('readTranscriptUsage attributes usage to the message.model that produced it', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, {
    inputTokens: 11, outputTokens: 22, cacheCreationInputTokens: 33, cacheReadInputTokens: 44,
    byModel: {
      'claude-sonnet-5': { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
      'claude-opus-5': { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
    },
  });
});

test('readTranscriptUsage sums repeated turns from the same model into one byModel bucket', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 2, cache_read_input_tokens: 2 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage.byModel, {
    'claude-sonnet-5': { inputTokens: 3, outputTokens: 3, cacheCreationInputTokens: 3, cacheReadInputTokens: 3 },
  });
});

test('readTranscriptUsage counts a repeated message.id toward its model only once', async () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 138, cache_creation_input_tokens: 12942, cache_read_input_tokens: 19608 } },
  });
  const lines = [line, line, line].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage.byModel, {
    'claude-sonnet-5': { inputTokens: 2, outputTokens: 138, cacheCreationInputTokens: 12942, cacheReadInputTokens: 19608 },
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test libs/workspace-bootstrap/test/tokens.test.js`
Expected: every test fails — `readTranscriptUsage` doesn't return a `byModel`
key yet, so every `assert.deepEqual` mismatches.

- [ ] **Step 3: Update `readTranscriptUsage`**

Overwrite `libs/workspace-bootstrap/src/tokens.js`:

```js
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
  target.cacheReadInputTokens += delta.cacheReadInputTokens;
}

// Every Claude Code hook payload carries transcript_path, a local JSONL file
// where each assistant turn has a message.usage object (and a message.model
// naming which model produced it). board.json never gets token counts from
// the hook payload itself — this is the only source.
export async function readTranscriptUsage(transcriptPath, { read = readFile } = {}) {
  let raw;
  try {
    raw = await read(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY_USAGE, byModel: {} };
  }
  const totals = { ...EMPTY_USAGE };
  const byModel = {};
  const seenMessageIds = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) continue;
    // Claude Code writes one JSONL line per content block (thinking/text/tool_use)
    // of a single API response, repeating the same usage on every line for that
    // response, keyed by the same message.id — count each response's usage once.
    const messageId = entry.message?.id;
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    const delta = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    };
    addUsage(totals, delta);

    // A session can span multiple models if the user switches mid-session;
    // attribute each turn's usage to the model that produced it so cost can
    // be computed per model instead of a single blended rate.
    const model = entry.message?.model;
    if (model) {
      const bucket = byModel[model] ?? { ...EMPTY_USAGE };
      addUsage(bucket, delta);
      byModel[model] = bucket;
    }
  }
  return { ...totals, byModel };
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

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test libs/workspace-bootstrap/test/tokens.test.js`
Expected: `# pass 19`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add libs/workspace-bootstrap/src/tokens.js libs/workspace-bootstrap/test/tokens.test.js
git commit -m "feat(workspace-bootstrap): attribute transcript usage to the model that produced it"
```

---

## Task 2: Add the pricing module

Client-side only — cost is computed at render time from the raw `byModel`
counts already in `history.jsonl`, never frozen at write time, so a pricing
correction here retroactively re-prices the entire history.

`costByModel` is the single source of truth: for a session with a
`byModel` breakdown, it prices each model's tokens at that model's rate; for
a session with no breakdown at all (every pre-migration `history.jsonl`
entry, or a turn whose transcript line had no `message.model`), it prices
the session's raw totals at the `default` rate under the key `'unknown'` —
so cost is never silently dropped for old data. `costOf` is just the sum of
`costByModel`'s values.

**Files:**
- Create: `apps/board/src/pricing.js`
- Test: `apps/board/src/pricing.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test, expect } from 'vitest';
import { costByModel, costOf, PRICING } from './pricing.js';

function usage(overrides = {}) {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, ...overrides };
}

test('costByModel prices a single model at its own rate', () => {
  const result = costByModel({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(result).toEqual({ 'claude-sonnet-5': 22.05 }); // 3 + 15 + 3.75 + 0.3, from PRICING['claude-sonnet-5']
});

test('costByModel prices multiple models independently and does not blend rates', () => {
  const result = costByModel({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      'claude-opus-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(result).toEqual({ 'claude-sonnet-5': 22.05, 'claude-opus-5': 110.25 });
});

test('costByModel falls back to the default rate under an "unknown" key when byModel is empty', () => {
  const result = costByModel({ ...usage({ inputTokens: 1_000_000 }), byModel: {} });
  expect(result).toEqual({ unknown: 3 }); // PRICING.default.input
});

test('costByModel falls back to the default rate under an "unknown" key when byModel is absent (pre-migration entries)', () => {
  const result = costByModel(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  expect(result).toEqual({ unknown: 18 }); // 3 + 15, PRICING.default
});

test('costByModel returns an empty object for null/undefined usage', () => {
  expect(costByModel(null)).toEqual({});
  expect(costByModel(undefined)).toEqual({});
});

test('costByModel prices an unrecognized model name at the default rate, keyed by its own name', () => {
  const result = costByModel({ byModel: { 'some-future-model': usage({ inputTokens: 1_000_000 }) } });
  expect(result).toEqual({ 'some-future-model': 3 });
});

test('costOf sums every model bucket from costByModel into one total', () => {
  const total = costOf({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      'claude-opus-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(total).toEqual(132.3);
});

test('costOf returns 0 for null usage', () => {
  expect(costOf(null)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/board/vite.config.js src/pricing.test.js`
Expected: FAIL — `Failed to resolve import "./pricing.js"`

- [ ] **Step 3: Write the implementation**

```js
// apps/board/src/pricing.js
// €/million tokens. Maintained by hand — no network pricing lookup. Update
// this table (and only this table) when Anthropic's published prices change;
// cost is computed at render time from raw token counts, so a correction here
// retroactively re-prices the entire history.
export const PRICING = {
  'claude-opus-5': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  default: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

const PER_MILLION = 1_000_000;
const UNKNOWN_MODEL = 'unknown';

function costForModel(usage, rate) {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) * rate.input
    + (usage.outputTokens ?? 0) * rate.output
    + (usage.cacheCreationInputTokens ?? 0) * rate.cacheWrite
    + (usage.cacheReadInputTokens ?? 0) * rate.cacheRead
  ) / PER_MILLION;
}

// Cost broken down per model, so a chart can render one segment per model.
// A session with no byModel breakdown (pre-migration history, or a transcript
// turn with no message.model) is priced as a whole at the default rate, under
// the 'unknown' key — never silently dropped or zeroed out.
export function costByModel(usage) {
  if (!usage) return {};
  const byModel = usage.byModel;
  if (byModel && Object.keys(byModel).length > 0) {
    const out = {};
    for (const [model, modelUsage] of Object.entries(byModel)) {
      out[model] = costForModel(modelUsage, PRICING[model] ?? PRICING.default);
    }
    return out;
  }
  return { [UNKNOWN_MODEL]: costForModel(usage, PRICING.default) };
}

export function costOf(usage) {
  return Object.values(costByModel(usage)).reduce((sum, cost) => sum + cost, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config apps/board/vite.config.js src/pricing.test.js`
Expected: `PASS (8) FAIL (0)`

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/pricing.js apps/board/src/pricing.test.js
git commit -m "feat(board): add per-model pricing for an estimated € cost"
```

---

## Task 3: Extract `Board.vue` from `App.vue`

Pure refactor, no behavior change: today's board content (summary header,
filters, columns, detail panel) moves into its own component, unchanged.
This is what makes Task 4's router able to render "the board" and "history"
as two independent route components. Because nothing about *what's rendered*
changes, the existing `App.test.js` suite is the regression guard — it
should pass unmodified after this task. (One cosmetic side effect: the
`FilterBar` now renders inside `Board.vue`'s own content instead of in the
shared top bar, since it's bound to filter state that belongs to the board
view. No existing test asserts its position, only its presence.)

**Files:**
- Create: `apps/board/src/Board.vue`
- Modify: `apps/board/src/App.vue`

- [ ] **Step 1: Create `Board.vue`**

```vue
<script setup>
import { computed, ref } from 'vue';
import Column from './Column.vue';
import SummaryHeader from './SummaryHeader.vue';
import FilterBar from './FilterBar.vue';
import RepoDetail from './RepoDetail.vue';
import { STATUS_ORDER, STATUS_STYLES } from './statusStyles.js';

const props = defineProps({
  repos: { type: Object, required: true },
  config: { type: Object, required: true },
  now: { type: Number, required: true },
  fetchImpl: { type: Function, required: true },
  refresh: { type: Function, required: true },
});

const nameFilter = ref('');
const techFilter = ref('');
const selected = ref(null); // { name, sessionId } | null

const technologies = computed(() => {
  const set = new Set();
  for (const meta of Object.values(props.config)) for (const t of meta.technologies ?? []) set.add(t);
  return [...set].sort();
});

const COLUMNS = STATUS_ORDER.map((status) => ({ status, title: STATUS_STYLES[status].label }));

const filtered = computed(() => {
  const out = {};
  for (const [name, repo] of Object.entries(props.repos)) {
    if (nameFilter.value && !name.toLowerCase().includes(nameFilter.value.toLowerCase())) continue;
    if (techFilter.value && !(props.config[name]?.technologies ?? []).includes(techFilter.value)) continue;
    out[name] = repo;
  }
  return out;
});

// A repo's card shows up in every column that has at least one of its
// sessions; each column's copy lists only that column's sessions. A repo
// with no sessions at all still shows a placeholder card in "todo".
function entriesFor(status) {
  const out = [];
  for (const [name, repoEntry] of Object.entries(filtered.value)) {
    const allSessions = Object.entries(repoEntry.sessions ?? {});
    if (allSessions.length === 0) {
      if (status === 'todo') out.push({ name, sessions: [] });
      continue;
    }
    const sessions = allSessions
      .filter(([, s]) => s.status === status)
      .map(([sessionId, s]) => ({ sessionId, ...s }));
    if (sessions.length > 0) out.push({ name, sessions });
  }
  return out;
}
const grouped = computed(() => COLUMNS.map((c) => ({ ...c, entries: entriesFor(c.status) })));

async function onCloseSession({ repo, sessionId }) {
  const label = props.repos[repo]?.sessions?.[sessionId]?.title ?? sessionId;
  if (!window.confirm(`Marquer la session « ${label} » de ${repo} comme terminée ?`)) return;
  await props.fetchImpl('/api/sessions/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, sessionId }),
  });
  await props.refresh();
}

const selectedRepo = computed(() => (selected.value ? props.repos[selected.value.name] : null));
const selectedSession = computed(() => selectedRepo.value?.sessions?.[selected.value?.sessionId] ?? null);
const selectedMeta = computed(() => (selected.value ? props.config[selected.value.name] ?? null : null));
</script>

<template>
  <div>
    <div class="flex items-center gap-2 flex-wrap mb-4">
      <FilterBar
        :name="nameFilter" :tech="techFilter" :technologies="technologies"
        @update:name="nameFilter = $event" @update:tech="techFilter = $event"
      />
    </div>

    <SummaryHeader :repos="repos" />

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <Column
        v-for="c in grouped" :key="c.status"
        :title="c.title" :status="c.status" :entries="c.entries" :now="now"
        @open="selected = $event"
        @close-session="onCloseSession"
      />
    </div>

    <RepoDetail
      :name="selected?.name ?? null" :session="selectedSession" :meta="selectedMeta" :now="now"
      @close="selected = null"
    />
  </div>
</template>
```

- [ ] **Step 2: Update `App.vue` to delegate the board view to it**

Replace the whole file:

```vue
<script setup>
import { computed, ref } from 'vue';
import Board from './Board.vue';
import HistoryView from './HistoryView.vue';
import { useBoard } from './useBoard.js';
import { useConfig } from './useConfig.js';
import { useNotifications } from './useNotifications.js';
import { useHistory } from './useHistory.js';
import { useNow } from './useRelativeTime.js';

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});
const fetchImpl = props.fetchImpl ?? fetch;

const { repos, transitions, connected, refresh } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
const { repos: config } = useConfig({ fetchImpl });
const now = useNow();

const questionCount = computed(() => {
  let n = 0;
  for (const repoEntry of Object.values(repos.value)) {
    for (const s of Object.values(repoEntry.sessions ?? {})) {
      if (s.status === 'question') n += 1;
    }
  }
  return n;
});
const { permission, soundOn, requestPermission, toggleSound } = useNotifications(transitions, questionCount, {});
const { entries: historyEntries, load: loadHistory } = useHistory({ fetchImpl });
const view = ref('board');
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-slate-900">ai-sync · workspace board</h1>
        <div class="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
          <button
            data-test="view-board"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', view === 'board' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
            @click="view = 'board'"
          >Board</button>
          <button
            data-test="view-history"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', view === 'history' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
            @click="view = 'history'; loadHistory()"
          >Historique</button>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-amber-700">⚠ déconnecté — nouvelle tentative au prochain poll…</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-slate-500">Notifications bloquées par le navigateur.</p>

    <Board v-if="view === 'board'" :repos="repos" :config="config" :now="now" :fetch-impl="fetchImpl" :refresh="refresh" />
    <HistoryView v-else :entries="historyEntries" />
  </main>
</template>
```

- [ ] **Step 3: Run the existing board test suite to confirm nothing broke**

Run: `npx vitest run --config apps/board/vite.config.js src/App.test.js`
Expected: `PASS (8) FAIL (0)` — same 8 tests as before this task, all still green, no edits needed to `App.test.js` itself.

- [ ] **Step 4: Commit**

```bash
git add apps/board/src/Board.vue apps/board/src/App.vue
git commit -m "refactor(board): extract the board view into Board.vue"
```

---

## Task 4: Add `vue-router` and the dedicated `/history` route

See the "Before you start" note at the top of this plan for why the version
is pinned to `^4.6.0` rather than `latest`.

**Files:**
- Modify: `apps/board/package.json` (via `npm install`)
- Create: `apps/board/src/router.js`
- Rename: `apps/board/src/HistoryView.vue` → `HistoryTable.vue`
- Rename: `apps/board/src/HistoryView.test.js` → `HistoryTable.test.js`
- Create: `apps/board/src/HistoryPage.vue`
- Create: `apps/board/src/HistoryPage.test.js`
- Modify: `apps/board/src/main.js`
- Modify: `apps/board/src/App.vue`
- Modify: `apps/board/src/App.test.js`

- [ ] **Step 1: Install `vue-router`**

```bash
npm install vue-router@^4.6.0 --workspace apps/board
```

Verify `apps/board/package.json`'s `dependencies` now includes
`"vue-router": "^4.6.0"`.

- [ ] **Step 2: Rename the history table component and its test**

```bash
git mv apps/board/src/HistoryView.vue apps/board/src/HistoryTable.vue
git mv apps/board/src/HistoryView.test.js apps/board/src/HistoryTable.test.js
```

- [ ] **Step 3: Update the renamed test file's import and identifiers**

Overwrite `apps/board/src/HistoryTable.test.js` (identical to the old
`HistoryView.test.js` except `HistoryView` → `HistoryTable` throughout):

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryTable from './HistoryTable.vue';

function entry(overrides = {}) {
  return {
    repo: 'oc-be',
    sessionId: 's1',
    title: 'fix login',
    startedAt: '2026-06-21T09:00:00.000Z',
    endedAt: '2026-06-21T09:10:00.000Z',
    usage: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 300, cacheReadInputTokens: 400 },
    ...overrides,
  };
}

test('renders one row per entry', () => {
  const w = mount(HistoryTable, { props: { entries: [entry(), entry({ sessionId: 's2', repo: 'other' })] } });
  expect(w.findAll('[data-test=history-row]')).toHaveLength(2);
});

test('shows a placeholder message when there are no entries', () => {
  const w = mount(HistoryTable, { props: { entries: [] } });
  expect(w.text()).toContain('Aucune session terminée');
});

test('filtering by repo name hides non-matching rows', async () => {
  const w = mount(HistoryTable, { props: { entries: [entry(), entry({ sessionId: 's2', repo: 'other' })] } });
  await w.get('[data-test=history-repo-filter]').setValue('oc-be');
  const rows = w.findAll('[data-test=history-row]');
  expect(rows).toHaveLength(1);
  expect(rows[0].text()).toContain('oc-be');
});

test('clicking a column header sorts rows, and clicking again reverses the order', async () => {
  const w = mount(HistoryTable, {
    props: { entries: [entry({ repo: 'b', sessionId: 's1' }), entry({ repo: 'a', sessionId: 's2' })] },
  });
  await w.get('[data-test=sort-repo]').trigger('click');
  let rows = w.findAll('[data-test=history-row]');
  expect(rows[0].text()).toContain('a');
  await w.get('[data-test=sort-repo]').trigger('click');
  rows = w.findAll('[data-test=history-row]');
  expect(rows[0].text()).toContain('b');
});
```

Note `HistoryTable.vue`'s own content is untouched (still the file that was
`HistoryView.vue` — the `git mv` in Step 2 already handles it).

- [ ] **Step 4: Create the minimal `HistoryPage.vue`**

Just wraps data-fetching + the table for now — Task 8 extends this with
tabs, the granularity selector, and both charts.

```vue
<script setup>
import { useHistory } from './useHistory.js';
import HistoryTable from './HistoryTable.vue';

const props = defineProps({
  fetchImpl: { type: Function, required: true },
});
const { entries } = useHistory({ fetchImpl: props.fetchImpl });
</script>

<template>
  <HistoryTable :entries="entries" />
</template>
```

- [ ] **Step 5: Create `HistoryPage.test.js`**

```js
import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HistoryPage from './HistoryPage.vue';

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

test('fetches history on mount and renders it in the table', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    json: async () => ([{
      repo: 'oc-be', sessionId: 's1', title: 'fix login',
      startedAt: null, endedAt: '2026-08-07T10:00:00.000Z',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
    }]),
  });
  const wrapper = mount(HistoryPage, { props: { fetchImpl } });
  await settle();
  expect(fetchImpl).toHaveBeenCalledWith('/api/history');
  expect(wrapper.text()).toContain('fix login');
});
```

- [ ] **Step 6: Create `router.js`**

```js
import { createRouter, createWebHistory } from 'vue-router';
import Board from './Board.vue';
import HistoryPage from './HistoryPage.vue';

// Accepts an injectable history implementation so tests can use
// createMemoryHistory() instead of touching the real browser URL.
export function createBoardRouter(history = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'board', component: Board },
      { path: '/history', name: 'history', component: HistoryPage },
    ],
  });
}
```

- [ ] **Step 7: Install the router in `main.js`**

```js
import { createApp } from 'vue';
import App from './App.vue';
import { createBoardRouter } from './router.js';
import './style.css';

const app = createApp(App);
app.use(createBoardRouter());
app.mount('#app');
```

- [ ] **Step 8: Rewrite `App.vue` as the router shell**

The `view` ref and the two `useHistory`/`HistoryView` wiring move out
entirely — `HistoryPage.vue` now owns its own data fetching, only mounted
when the route matches. `useBoard`/`useConfig`/`useNotifications` stay here
(not in `Board.vue`) specifically so notifications keep firing via the
`transitions` watcher even while the user is looking at `/history` — moving
them into `Board.vue` would stop the poll interval every time the user
navigates away from `/`.

```vue
<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useBoard } from './useBoard.js';
import { useConfig } from './useConfig.js';
import { useNotifications } from './useNotifications.js';
import { useNow } from './useRelativeTime.js';

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});
const fetchImpl = props.fetchImpl ?? fetch;

const { repos, transitions, connected, refresh } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
const { repos: config } = useConfig({ fetchImpl });
const now = useNow();
const route = useRoute();

const questionCount = computed(() => {
  let n = 0;
  for (const repoEntry of Object.values(repos.value)) {
    for (const s of Object.values(repoEntry.sessions ?? {})) {
      if (s.status === 'question') n += 1;
    }
  }
  return n;
});
const { permission, soundOn, requestPermission, toggleSound } = useNotifications(transitions, questionCount, {});

const routeProps = computed(() => (route.name === 'history'
  ? { fetchImpl }
  : { repos: repos.value, config: config.value, now: now.value, fetchImpl, refresh }));
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-slate-900">ai-sync · workspace board</h1>
        <div class="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
          <router-link
            data-test="view-board" to="/"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', route.name === 'board' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
          >Board</router-link>
          <router-link
            data-test="view-history" to="/history"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', route.name === 'history' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700']"
          >Historique</router-link>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-200 rounded-lg shadow-sm hover:shadow px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-amber-700">⚠ déconnecté — nouvelle tentative au prochain poll…</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-slate-500">Notifications bloquées par le navigateur.</p>

    <router-view v-slot="{ Component }">
      <component :is="Component" v-bind="routeProps" />
    </router-view>
  </main>
</template>
```

- [ ] **Step 9: Rewrite `App.test.js` for router-based navigation**

Mounting `App` now requires providing a router (via `global.plugins`), and
navigation happens through `router-link` clicks or a direct `router.push`
instead of toggling a local `view` ref. This also adds a deep-link test,
which is the concrete proof that `/history` is a real, reloadable route —
the core ask of this feature.

```js
import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from './App.vue';
import Column from './Column.vue';
import { createBoardRouter } from './router.js';

afterEach(() => { vi.restoreAllMocks(); });

function routedFetch() {
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/config') {
      return Promise.resolve({ json: async () => ({ repos: { a: { url: 'u', technologies: ['nestjs'], targets: [] } } }) });
    }
    if (url === '/api/history') {
      return Promise.resolve({ json: async () => ([]) });
    }
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: {
        a: { sessions: {} }, // idle repo -> todo placeholder card
        b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } },
        c: { sessions: { s2: { status: 'question', lastEvent: 'Notification', updatedAt: 'T', title: 'review PR', lastPrompt: 'review PR', events: [] } } },
        d: { sessions: { // one repo, two sessions in two different statuses -> two separate cards
          s3: { status: 'todo', lastEvent: 'init', updatedAt: 'T', title: 'd todo item', lastPrompt: 'd todo item', events: [] },
          s4: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'd question item', lastPrompt: 'd question item', events: [] },
        } },
      },
    }) });
  });
}

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }

async function mountApp(fetchImpl, { path = '/' } = {}) {
  // Reuses the real route table instead of duplicating it, so the test
  // exercises exactly what main.js installs.
  const router = createBoardRouter(createMemoryHistory());
  router.push(path);
  await router.isReady();
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 }, global: { plugins: [router] } });
  await settle();
  return { wrapper, router };
}

test('App groups repos into the four columns', async () => {
  const { wrapper } = await mountApp(routedFetch());
  const columns = wrapper.findAll('section');
  expect(columns).toHaveLength(4);
  expect(columns[2].text()).toContain('(3)'); // repos b, c and d each have a session in "question"
  expect(wrapper.text()).toContain('a');
  expect(wrapper.text()).toContain('b');
});

test('a repo with sessions in two different statuses gets a separate card per matching column', async () => {
  const { wrapper } = await mountApp(routedFetch());
  const columns = wrapper.findAll('section');
  const todoColumn = columns[0];
  const questionColumn = columns[2];

  expect(todoColumn.text()).toContain('d');
  expect(questionColumn.text()).toContain('d');
  expect(todoColumn.text()).toContain('d todo item');
  expect(todoColumn.text()).not.toContain('d question item');
  expect(questionColumn.text()).toContain('d question item');
  expect(questionColumn.text()).not.toContain('d todo item');
});

test('App renders the summary header and filter bar', async () => {
  const { wrapper } = await mountApp(routedFetch());
  expect(wrapper.text()).toContain('repos');
  expect(wrapper.find('[data-test=search]').exists()).toBe(true);
});

test('clicking a session row opens the detail panel', async () => {
  const { wrapper } = await mountApp(routedFetch());
  await wrapper.get('[data-test=session-row]').trigger('click');
  expect(wrapper.find('aside').exists()).toBe(true);
});

test('typing in the search filters the cards', async () => {
  const { wrapper } = await mountApp(routedFetch());
  await wrapper.get('[data-test=search]').setValue('b');
  await nextTick();
  expect(wrapper.text()).toContain('b');
  expect(wrapper.text()).not.toContain('Notification'); // card 'c' filtered out
});

test('clicking the Historique tab navigates to /history and shows history entries instead of the board', async () => {
  const fetchImpl = vi.fn().mockImplementation((url) => {
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/history') {
      return Promise.resolve({
        json: async () => ([{
          repo: 'oc-be', sessionId: 's1', title: 'fix login',
          startedAt: 'T0', endedAt: 'T1',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
        }]),
      });
    }
    return Promise.resolve({ json: async () => ({ version: 2, repos: {} }) });
  });
  const { wrapper, router } = await mountApp(fetchImpl);
  await wrapper.get('[data-test=view-history]').trigger('click');
  await settle();
  expect(router.currentRoute.value.path).toBe('/history');
  expect(wrapper.find('section').exists()).toBe(false);
  expect(wrapper.text()).toContain('fix login');
});

test('opening /history directly renders the history page (deep link)', async () => {
  const fetchImpl = vi.fn().mockImplementation((url) => {
    if (url === '/api/history') {
      return Promise.resolve({
        json: async () => ([{
          repo: 'oc-be', sessionId: 's1', title: 'fix login',
          startedAt: 'T0', endedAt: 'T1',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
        }]),
      });
    }
    return Promise.resolve({ json: async () => ({ version: 2, repos: {} }) });
  });
  const { wrapper } = await mountApp(fetchImpl, { path: '/history' });
  expect(wrapper.text()).toContain('fix login');
  expect(wrapper.find('section').exists()).toBe(false);
});

test('dropping a session on Done confirms, closes it via the API, and refreshes the board', async () => {
  const calls = [];
  const fetchImpl = vi.fn().mockImplementation((url) => {
    calls.push(url);
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/sessions/close') return Promise.resolve({ json: async () => ({ closed: true }) });
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: { b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } } },
    }) });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { wrapper } = await mountApp(fetchImpl);
  const boardCallsBefore = calls.filter((u) => u === '/api/board').length;

  const doneColumn = wrapper.findAllComponents(Column)[3];
  await doneColumn.vm.$emit('close-session', { repo: 'b', sessionId: 's1' });
  await settle();

  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('fix login'));
  const closeCall = fetchImpl.mock.calls.find(([u]) => u === '/api/sessions/close');
  expect(closeCall[1]).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'b', sessionId: 's1' }),
  });
  const boardCallsAfter = calls.filter((u) => u === '/api/board').length;
  expect(boardCallsAfter).toBeGreaterThan(boardCallsBefore);
});

test('declining the confirm on drop does not call the close API', async () => {
  const fetchImpl = routedFetch();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const { wrapper } = await mountApp(fetchImpl);
  const doneColumn = wrapper.findAllComponents(Column)[3];
  await doneColumn.vm.$emit('close-session', { repo: 'b', sessionId: 's1' });
  await settle();
  expect(fetchImpl.mock.calls.some(([u]) => u === '/api/sessions/close')).toBe(false);
});
```

- [ ] **Step 10: Run the full board test suite**

Run: `npx vitest run --config apps/board/vite.config.js`
Expected: all files pass, including `App.test.js` (9 tests, including the 2
new routing tests) and `HistoryPage.test.js` (1 test).

- [ ] **Step 11: Commit**

```bash
git add apps/board/package.json apps/board/package-lock.json apps/board/src/router.js \
  apps/board/src/HistoryTable.vue apps/board/src/HistoryTable.test.js \
  apps/board/src/HistoryPage.vue apps/board/src/HistoryPage.test.js \
  apps/board/src/main.js apps/board/src/App.vue apps/board/src/App.test.js \
  package-lock.json
git commit -m "feat(board): give the Historique tab its own /history route"
```

(`package-lock.json` may be touched at the repo root instead of/in addition
to `apps/board/package-lock.json` depending on how the workspace install
resolved — `git status` after Step 1 shows exactly which lockfile changed;
add whichever one it is.)

---

## Task 5: Add `useHistoryStats.js`

Pure client-side aggregation over the entries `useHistory` already fetches —
no new API endpoint. Two functions: `bucketByPeriod(granularity)` groups
entries by day/week/month/year (bucketed by `endedAt` in **UTC**, not the
browser's local timezone — this is a deliberate deviation from the design
doc's wording, made for deterministic, timezone-independent tests; the
visible difference to a user is at most one bucket's worth of session near a
UTC day boundary, which doesn't change any total). `totalsByProject()`
aggregates every entry by repo, over the **entire** history — there's no
date-range picker in scope, so there is only one "window" for both charts to
share, and granularity only changes how the time chart buckets that same
window, not which entries are included.

**Files:**
- Create: `apps/board/src/useHistoryStats.js`
- Test: `apps/board/src/useHistoryStats.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test, expect } from 'vitest';
import { ref } from 'vue';
import { useHistoryStats, bucketKey } from './useHistoryStats.js';

function entry(overrides = {}) {
  return {
    repo: 'oc-be',
    sessionId: 's1',
    endedAt: '2026-08-07T19:42:41.721Z',
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    ...overrides,
  };
}

test('bucketKey buckets by day/week/month/year in UTC', () => {
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'day')).toBe('2026-08-07');
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'week')).toBe('2026-08-03'); // Monday of that week
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'month')).toBe('2026-08');
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'year')).toBe('2026');
});

test('bucketKey\'s week bucket crosses a year boundary correctly', () => {
  expect(bucketKey('2026-01-01T00:00:00.000Z', 'week')).toBe('2025-12-29'); // Monday of the week containing Jan 1 2026
});

test('bucketByPeriod groups entries into sorted, token-summed buckets', () => {
  const entries = ref([
    entry({ sessionId: 's1', endedAt: '2026-08-07T10:00:00.000Z', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } }),
    entry({ sessionId: 's2', endedAt: '2026-08-07T20:00:00.000Z', usage: { inputTokens: 2, outputTokens: 2, cacheCreationInputTokens: 2, cacheReadInputTokens: 2 } }),
    entry({ sessionId: 's3', endedAt: '2026-08-08T10:00:00.000Z', usage: { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  const buckets = bucketByPeriod('day');
  expect(buckets.map((b) => b.key)).toEqual(['2026-08-07', '2026-08-08']);
  expect(buckets[0].tokens).toEqual({ inputTokens: 3, outputTokens: 3, cacheCreationInputTokens: 3, cacheReadInputTokens: 3 });
  expect(buckets[1].tokens).toEqual({ inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
});

test('bucketByPeriod excludes entries with no endedAt (nothing to bucket by)', () => {
  const entries = ref([
    entry({ sessionId: 's1', endedAt: null }),
    entry({ sessionId: 's2', endedAt: '2026-08-07T10:00:00.000Z' }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  expect(bucketByPeriod('day')).toHaveLength(1);
});

test('bucketByPeriod attributes cost per model, and pre-migration entries with no byModel go under "unknown"', () => {
  const entries = ref([
    entry({
      sessionId: 's1',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: { 'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } },
    }),
    entry({
      sessionId: 's2',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, // no byModel at all
    }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  const [bucket] = bucketByPeriod('day');
  expect(bucket.costByModel).toEqual({ 'claude-sonnet-5': 3, unknown: 3 });
});

test('totalsByProject aggregates every entry by repo, regardless of granularity, sorted by token volume descending', () => {
  const entries = ref([
    entry({ repo: 'a', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } }),
    entry({ repo: 'b', sessionId: 's2', usage: { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
    entry({ repo: 'a', sessionId: 's3', usage: { inputTokens: 2, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
  ]);
  const { totalsByProject } = useHistoryStats(entries);
  const totals = totalsByProject();
  expect(totals.map((t) => t.repo)).toEqual(['b', 'a']);
  expect(totals[1].tokens).toEqual({ inputTokens: 3, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 });
});

test('totalsByProject includes entries with no endedAt (only time-bucketing needs a timestamp)', () => {
  const entries = ref([entry({ repo: 'a', endedAt: null })]);
  const { totalsByProject } = useHistoryStats(entries);
  expect(totalsByProject()).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/board/vite.config.js src/useHistoryStats.test.js`
Expected: FAIL — `Failed to resolve import "./useHistoryStats.js"`

- [ ] **Step 3: Write the implementation**

```js
import { costByModel } from './pricing.js';

function emptyTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function addTokenUsage(target, usage) {
  target.inputTokens += usage?.inputTokens ?? 0;
  target.outputTokens += usage?.outputTokens ?? 0;
  target.cacheCreationInputTokens += usage?.cacheCreationInputTokens ?? 0;
  target.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
}

function addCostByModel(target, usage) {
  for (const [model, cost] of Object.entries(costByModel(usage))) {
    target[model] = (target[model] ?? 0) + cost;
  }
}

function tokenTotal(tokens) {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}

// UTC-based (not the browser's local time) so bucketing is deterministic
// regardless of where this runs.
export function bucketKey(iso, granularity) {
  const d = new Date(iso);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (granularity === 'year') return String(year);
  if (granularity === 'month') return `${year}-${String(month + 1).padStart(2, '0')}`;
  if (granularity === 'day') return d.toISOString().slice(0, 10);
  // week: Monday-start, keyed by that Monday's date
  const monday = new Date(Date.UTC(year, month, d.getUTCDate()));
  const dow = (monday.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  monday.setUTCDate(monday.getUTCDate() - dow);
  return monday.toISOString().slice(0, 10);
}

// entries: a Vue ref/computed wrapping the array useHistory() already fetched.
export function useHistoryStats(entries) {
  function bucketByPeriod(granularity) {
    const buckets = new Map();
    for (const entry of entries.value) {
      if (!entry.endedAt) continue;
      const key = bucketKey(entry.endedAt, granularity);
      if (!buckets.has(key)) buckets.set(key, { key, tokens: emptyTokenUsage(), costByModel: {} });
      const bucket = buckets.get(key);
      addTokenUsage(bucket.tokens, entry.usage);
      addCostByModel(bucket.costByModel, entry.usage);
    }
    return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  function totalsByProject() {
    const totals = new Map();
    for (const entry of entries.value) {
      if (!totals.has(entry.repo)) totals.set(entry.repo, { repo: entry.repo, tokens: emptyTokenUsage(), costByModel: {} });
      const t = totals.get(entry.repo);
      addTokenUsage(t.tokens, entry.usage);
      addCostByModel(t.costByModel, entry.usage);
    }
    return [...totals.values()].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
  }

  return { bucketByPeriod, totalsByProject };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config apps/board/vite.config.js src/useHistoryStats.test.js`
Expected: `PASS (7) FAIL (0)`

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useHistoryStats.js apps/board/src/useHistoryStats.test.js
git commit -m "feat(board): add client-side history bucketing by period and by project"
```

---

## Task 6: Add `TimeSeriesChart.vue`

A thin wrapper around a native Chart.js instance — no third-party Vue chart
library. jsdom (used by Vitest here) doesn't implement `<canvas>`, so the
test mocks the `chart.js` module itself and asserts on the config the
component would have handed to `new Chart(...)`, rather than rendering
pixels.

**Files:**
- Create: `apps/board/src/TimeSeriesChart.vue`
- Test: `apps/board/src/TimeSeriesChart.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import TimeSeriesChart from './TimeSeriesChart.vue';

const chartInstances = [];
vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor(canvas, config) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      chartInstances.push(this);
    }
    update() {}
    destroy() { this.destroyed = true; }
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => { chartInstances.length = 0; vi.restoreAllMocks(); });

function bucket(overrides = {}) {
  return {
    key: '2026-08-01',
    tokens: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    costByModel: { 'claude-sonnet-5': 0.01 },
    ...overrides,
  };
}

test('renders one stacked dataset per token type in tokens mode', () => {
  mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  const chart = chartInstances[0];
  expect(chart.data.labels).toEqual(['2026-08-01']);
  expect(chart.data.datasets.map((d) => d.label)).toEqual(['Input', 'Output', 'Cache écrit', 'Cache lu']);
  expect(chart.data.datasets[0].data).toEqual([10]);
  expect(chart.options.scales.x.stacked).toBe(true);
});

test('renders one dataset per model in cost mode, labeling a missing model as "Modèle inconnu"', () => {
  mount(TimeSeriesChart, {
    props: {
      buckets: [bucket({ costByModel: { 'claude-sonnet-5': 0.02, unknown: 0.01 } })],
      mode: 'cost',
    },
  });
  const chart = chartInstances[0];
  expect(chart.data.datasets.map((d) => d.label).sort()).toEqual(['Modèle inconnu', 'claude-sonnet-5']);
});

test('re-renders (not re-creates) the chart when buckets or mode change', async () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  await wrapper.setProps({ buckets: [bucket({ key: '2026-08-02' })], mode: 'tokens' });
  expect(chartInstances).toHaveLength(1); // same instance, updated in place
  expect(chartInstances[0].data.labels).toEqual(['2026-08-02']);
});

test('destroys the chart instance on unmount', () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  const chart = chartInstances[0];
  wrapper.unmount();
  expect(chart.destroyed).toBe(true);
});

test('shows an empty-state message when there are no buckets', () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [], mode: 'tokens' } });
  expect(wrapper.text()).toContain('Aucune session terminée');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/board/vite.config.js src/TimeSeriesChart.test.js`
Expected: FAIL — `Failed to resolve import "./TimeSeriesChart.vue"`

- [ ] **Step 3: Install `chart.js`**

```bash
npm install chart.js@^4.5.0 --workspace apps/board
```

- [ ] **Step 4: Write the implementation**

```vue
<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps({
  buckets: { type: Array, required: true }, // [{ key, tokens, costByModel }]
  mode: { type: String, required: true }, // 'tokens' | 'cost'
});

const TOKEN_SERIES = [
  { key: 'inputTokens', label: 'Input', color: '#2563eb' },
  { key: 'outputTokens', label: 'Output', color: '#10b981' },
  { key: 'cacheCreationInputTokens', label: 'Cache écrit', color: '#f59e0b' },
  { key: 'cacheReadInputTokens', label: 'Cache lu', color: '#94a3b8' },
];
const MODEL_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
const UNKNOWN_COLOR = '#94a3b8';
const UNKNOWN_MODEL = 'unknown';

function modelLabel(model) {
  return model === UNKNOWN_MODEL ? 'Modèle inconnu' : model;
}

const modelKeys = computed(() => {
  const keys = new Set();
  for (const b of props.buckets) for (const m of Object.keys(b.costByModel)) keys.add(m);
  return [...keys].sort();
});

const datasets = computed(() => {
  if (props.mode === 'tokens') {
    return TOKEN_SERIES.map((s) => ({
      label: s.label,
      backgroundColor: s.color,
      data: props.buckets.map((b) => b.tokens[s.key]),
    }));
  }
  return modelKeys.value.map((model, i) => ({
    label: modelLabel(model),
    backgroundColor: model === UNKNOWN_MODEL ? UNKNOWN_COLOR : MODEL_COLORS[i % MODEL_COLORS.length],
    data: props.buckets.map((b) => Number((b.costByModel[model] ?? 0).toFixed(4))),
  }));
});

const canvas = ref(null);
let chart = null;

function render() {
  const config = {
    type: 'bar',
    data: { labels: props.buckets.map((b) => b.key), datasets: datasets.value },
    options: {
      responsive: true,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom' } },
    },
  };
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}

onMounted(render);
watch([() => props.buckets, () => props.mode], render);
onUnmounted(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div class="relative h-64">
    <canvas ref="canvas" data-test="time-series-canvas"></canvas>
    <p v-if="buckets.length === 0" class="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
      Aucune session terminée pour l'instant.
    </p>
  </div>
</template>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --config apps/board/vite.config.js src/TimeSeriesChart.test.js`
Expected: `PASS (5) FAIL (0)`

- [ ] **Step 6: Commit**

```bash
git add apps/board/package.json apps/board/package-lock.json package-lock.json \
  apps/board/src/TimeSeriesChart.vue apps/board/src/TimeSeriesChart.test.js
git commit -m "feat(board): add the stacked time-series consumption chart"
```

---

## Task 7: Add `ProjectBarChart.vue`

Same wrapper pattern as `TimeSeriesChart.vue`, one horizontal bar per repo.

**Files:**
- Create: `apps/board/src/ProjectBarChart.vue`
- Test: `apps/board/src/ProjectBarChart.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ProjectBarChart from './ProjectBarChart.vue';

const chartInstances = [];
vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor(canvas, config) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      chartInstances.push(this);
    }
    update() {}
    destroy() { this.destroyed = true; }
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => { chartInstances.length = 0; vi.restoreAllMocks(); });

function total(overrides = {}) {
  return {
    repo: 'oc-be',
    tokens: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    costByModel: { 'claude-sonnet-5': 0.05 },
    ...overrides,
  };
}

test('renders one horizontal bar per project in tokens mode', () => {
  mount(ProjectBarChart, {
    props: {
      totals: [total(), total({ repo: 'other', tokens: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } })],
      mode: 'tokens',
    },
  });
  const chart = chartInstances[0];
  expect(chart.data.labels).toEqual(['oc-be', 'other']);
  expect(chart.data.datasets[0].data).toEqual([36, 4]);
  expect(chart.options.indexAxis).toBe('y');
});

test('renders the summed cost across models in cost mode', () => {
  mount(ProjectBarChart, {
    props: { totals: [total({ costByModel: { 'claude-sonnet-5': 0.05, unknown: 0.02 } })], mode: 'cost' },
  });
  const chart = chartInstances[0];
  expect(chart.data.datasets[0].data).toEqual([0.07]);
  expect(chart.data.datasets[0].label).toBe('Coût (€)');
});

test('re-renders (not re-creates) the chart when totals or mode change', async () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [total()], mode: 'tokens' } });
  await wrapper.setProps({ totals: [total({ repo: 'other' })], mode: 'tokens' });
  expect(chartInstances).toHaveLength(1);
  expect(chartInstances[0].data.labels).toEqual(['other']);
});

test('destroys the chart instance on unmount', () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [total()], mode: 'tokens' } });
  const chart = chartInstances[0];
  wrapper.unmount();
  expect(chart.destroyed).toBe(true);
});

test('shows an empty-state message when there are no totals', () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [], mode: 'tokens' } });
  expect(wrapper.text()).toContain('Aucune session terminée');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/board/vite.config.js src/ProjectBarChart.test.js`
Expected: FAIL — `Failed to resolve import "./ProjectBarChart.vue"`

- [ ] **Step 3: Write the implementation**

```vue
<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps({
  totals: { type: Array, required: true }, // [{ repo, tokens, costByModel }]
  mode: { type: String, required: true }, // 'tokens' | 'cost'
});

function tokenTotal(tokens) {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}
function costTotal(costByModel) {
  return Object.values(costByModel).reduce((sum, c) => sum + c, 0);
}

const values = computed(() => (props.mode === 'tokens'
  ? props.totals.map((t) => tokenTotal(t.tokens))
  : props.totals.map((t) => Number(costTotal(t.costByModel).toFixed(4)))));

const canvas = ref(null);
let chart = null;

function render() {
  const config = {
    type: 'bar',
    data: {
      labels: props.totals.map((t) => t.repo),
      datasets: [{
        label: props.mode === 'tokens' ? 'Tokens' : 'Coût (€)',
        backgroundColor: '#2563eb',
        data: values.value,
      }],
    },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } } },
  };
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}

onMounted(render);
watch([() => props.totals, () => props.mode], render);
onUnmounted(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div class="relative h-64">
    <canvas ref="canvas" data-test="project-bar-canvas"></canvas>
    <p v-if="totals.length === 0" class="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
      Aucune session terminée pour l'instant.
    </p>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config apps/board/vite.config.js src/ProjectBarChart.test.js`
Expected: `PASS (5) FAIL (0)`

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/ProjectBarChart.vue apps/board/src/ProjectBarChart.test.js
git commit -m "feat(board): add the per-project consumption chart"
```

---

## Task 8: Wire tabs, granularity, and the Tokens⇄€ toggle into `HistoryPage.vue`

Replaces the minimal `HistoryPage.vue`/`HistoryPage.test.js` from Task 4
with the full tabbed page: **Par période** / **Par projet** tabs (only one
chart mounted at a time — confirmed by the visual-companion mockup review),
a Jour/Semaine/Mois/Année granularity selector for the time chart, and a
Tokens ⇄ € toggle that drives both charts. The detail table stays visible
under both tabs.

**Files:**
- Modify: `apps/board/src/HistoryPage.vue`
- Modify: `apps/board/src/HistoryPage.test.js`

- [ ] **Step 1: Replace `HistoryPage.test.js` with the full tabbed test suite**

```js
import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HistoryPage from './HistoryPage.vue';
import TimeSeriesChart from './TimeSeriesChart.vue';
import ProjectBarChart from './ProjectBarChart.vue';

vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor() {}
    update() {}
    destroy() {}
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => { vi.restoreAllMocks(); });

function entry(overrides = {}) {
  return {
    repo: 'oc-be', sessionId: 's1', title: 'fix login',
    startedAt: null, endedAt: '2026-08-07T10:00:00.000Z',
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function fetchImplWith(entries) {
  return vi.fn().mockResolvedValue({ json: async () => entries });
}

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

test('defaults to the "Par période" tab with day granularity, and always renders the table below', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(true);
  expect(wrapper.findComponent(ProjectBarChart).exists()).toBe(false);
  expect(wrapper.text()).toContain('fix login'); // HistoryTable row
});

test('switching to the "Par projet" tab shows the project chart instead of the time series', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  await wrapper.get('[data-test=tab-project]').trigger('click');
  await settle();
  expect(wrapper.findComponent(ProjectBarChart).exists()).toBe(true);
  expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(false);
});

test('changing granularity re-buckets the time-series chart', async () => {
  const wrapper = mount(HistoryPage, {
    props: { fetchImpl: fetchImplWith([entry(), entry({ sessionId: 's2', endedAt: '2026-09-01T10:00:00.000Z' })]) },
  });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(2); // two different days
  await wrapper.get('[data-test=granularity-month]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(2); // two different months too
  await wrapper.get('[data-test=granularity-year]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(1); // same year
});

test('the € toggle switches the active chart into cost mode', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('mode')).toBe('tokens');
  await wrapper.get('[data-test=mode-cost]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('mode')).toBe('cost');
});

test('the project chart reflects the mode toggle too', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  await wrapper.get('[data-test=tab-project]').trigger('click');
  await wrapper.get('[data-test=mode-cost]').trigger('click');
  await settle();
  expect(wrapper.findComponent(ProjectBarChart).props('mode')).toBe('cost');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/board/vite.config.js src/HistoryPage.test.js`
Expected: FAIL — the current `HistoryPage.vue` has no tabs, granularity
selector, or mode toggle, so none of the `data-test` selectors exist and
`TimeSeriesChart`/`ProjectBarChart` are never rendered.

- [ ] **Step 3: Rewrite `HistoryPage.vue`**

```vue
<script setup>
import { ref, computed } from 'vue';
import { useHistory } from './useHistory.js';
import { useHistoryStats } from './useHistoryStats.js';
import TimeSeriesChart from './TimeSeriesChart.vue';
import ProjectBarChart from './ProjectBarChart.vue';
import HistoryTable from './HistoryTable.vue';

const props = defineProps({
  fetchImpl: { type: Function, required: true },
});
const { entries } = useHistory({ fetchImpl: props.fetchImpl });

const mode = ref('tokens'); // 'tokens' | 'cost'
const tab = ref('period'); // 'period' | 'project'
const granularity = ref('day'); // 'day' | 'week' | 'month' | 'year'

const GRANULARITIES = [
  { key: 'day', label: 'Jour' },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
];

const { bucketByPeriod, totalsByProject } = useHistoryStats(entries);
const buckets = computed(() => bucketByPeriod(granularity.value));
const projectTotals = computed(() => totalsByProject());

function tabClass(active) {
  return ['rounded-md px-3 py-1 font-medium transition-colors', active ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'];
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm" role="tablist">
        <button data-test="tab-period" role="tab" :aria-selected="tab === 'period'" :class="tabClass(tab === 'period')" @click="tab = 'period'">Par période</button>
        <button data-test="tab-project" role="tab" :aria-selected="tab === 'project'" :class="tabClass(tab === 'project')" @click="tab = 'project'">Par projet</button>
      </div>
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
        <button data-test="mode-tokens" :class="tabClass(mode === 'tokens')" @click="mode = 'tokens'">Tokens</button>
        <button data-test="mode-cost" :class="tabClass(mode === 'cost')" @click="mode = 'cost'">€</button>
      </div>
    </div>

    <div v-if="tab === 'period'" class="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm mb-3">
        <button
          v-for="g in GRANULARITIES" :key="g.key"
          :data-test="`granularity-${g.key}`"
          :class="tabClass(granularity === g.key)"
          @click="granularity = g.key"
        >{{ g.label }}</button>
      </div>
      <TimeSeriesChart :buckets="buckets" :mode="mode" />
    </div>

    <div v-else class="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
      <ProjectBarChart :totals="projectTotals" :mode="mode" />
    </div>

    <HistoryTable :entries="entries" />
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config apps/board/vite.config.js src/HistoryPage.test.js`
Expected: `PASS (5) FAIL (0)`

- [ ] **Step 5: Run the full board suite once more**

Run: `npx vitest run --config apps/board/vite.config.js`
Expected: every file passes.

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/HistoryPage.vue apps/board/src/HistoryPage.test.js
git commit -m "feat(board): add period/project tabs and a tokens/€ toggle to the history page"
```

---

## Task 9: Update the changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the entry**

In the `## [Unreleased]` → `### Added` section, right after the existing
"Historique" tab bullet, insert:

```markdown
- The "Historique" tab now lives at its own `/history` route and adds
  consumption charts — by day/week/month/year, and by project — on top of
  the existing detailed session table, with a Tokens ⇄ € toggle. Token usage
  is now tracked per model (`message.model`) so the € estimate uses each
  model's own price instead of a single blended rate.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for the history page charts"
```

---

## Final verification

- [ ] Run: `node --test libs/workspace-bootstrap/test/tokens.test.js` — expect `# fail 0`
- [ ] Run: `npx vitest run --config apps/board/vite.config.js` — expect every file green
- [ ] Run: `npm run lint` — expect no violations (new files follow the existing `eslint-plugin-vue` essential rules; no new Node-only files were added to the `server.js`-style override list)
- [ ] Run: `npm run build` — expect the board app to build (confirms `vue-router`/`chart.js` resolve correctly at build time, not just in tests)
- [ ] Manually start the board (`npm start`) and confirm in a browser: `/` shows the board, `/history` shows the tabbed charts + table, reloading on `/history` doesn't 404, and switching the Tokens/€ toggle updates both the active chart and (after switching tabs) the other one.
