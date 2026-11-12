# Dashboard Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-only kanban dashboard alert you when an AI agent is blocked (`question`) or finished (`done`), and make each repo's state more legible and context-rich.

**Architecture:** Extend `board.json` with a bounded per-repo event history (additive, `version` stays `1`). Add a zero-dependency `GET /api/config` endpoint that surfaces `repos.json` metadata. On the front-end, keep polling but diff snapshots to detect status transitions, then drive browser notifications, a tab-title badge, a summary header, name/technology filters, and a right-hand detail panel with an event timeline.

**Tech Stack:** Node.js (`node:test`) for `src/` and the board server; Vue 3 `<script setup>` + Tailwind + Vitest + `@vue/test-utils` (jsdom) for the front-end.

**Spec:** `docs/superpowers/specs/2026-06-21-dashboard-improvements-design.md`

**Conventions:**
- `src/**/*.js` is under a 100% coverage gate (`npm test`). Every branch needs a test.
- Front-end + server suite: `npm run test:board`.
- Commit after each task. Replace `git` with `rtk git` if RTK is configured.

---

## Lot 1 — Data & server

### Task 1: Event history in the board writer (`src/board.js`)

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Update the existing `setStatus` test to expect an `events` array**

In `test/board.test.js`, replace the body of `setStatus reads, applies the transition with timestamp + event, and writes`:

```js
test('setStatus reads, applies the transition with timestamp + event, and writes', async () => {
  let written;
  const board = await setStatus('/x', 'example-api', 'question', {
    lastEvent: 'Notification',
    now: () => '2026-06-16T10:00:00Z',
    read: async () => JSON.stringify({ version: 1, repos: { 'example-api': { status: 'inprogress' } } }),
    write: async (_f, data) => { written = data; },
    move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos['example-api'], {
    status: 'question',
    updatedAt: '2026-06-16T10:00:00Z',
    lastEvent: 'Notification',
    events: [{ event: 'Notification', at: '2026-06-16T10:00:00Z' }],
  });
  assert.match(written, /"status": "question"/);
});
```

- [ ] **Step 2: Add a test that events accumulate newest-first and cap at `MAX_EVENTS`**

Append to `test/board.test.js`:

```js
test('setStatus prepends events newest-first and caps the history', async () => {
  const prior = Array.from({ length: 20 }, (_, i) => ({ event: `e${i}`, at: 'old' }));
  const board = await setStatus('/x', 'a', 'done', {
    lastEvent: 'pushed', now: () => 'NOW',
    read: async () => JSON.stringify({ version: 1, repos: { a: { status: 'inprogress', events: prior } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.events.length, 20);
  assert.deepEqual(board.repos.a.events[0], { event: 'pushed', at: 'NOW' });
  assert.equal(board.repos.a.events[19].event, 'e18'); // oldest entry dropped
});
```

- [ ] **Step 3: Update the `initRepos` test to expect an `events` array**

Replace the assertion block in `initRepos adds missing repos as todo without clobbering existing ones`:

```js
  assert.deepEqual(board.repos.a, { status: 'done', updatedAt: 'old', lastEvent: 'done' });
  assert.deepEqual(board.repos.b, { status: 'todo', updatedAt: 'T', lastEvent: 'init', events: [{ event: 'init', at: 'T' }] });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setStatus`/`initRepos` results lack `events`.

- [ ] **Step 5: Implement `events` in `src/board.js`**

Add the cap constant near the top (after `STATES`):

```js
export const MAX_EVENTS = 20;
```

Replace `setStatus`:

```js
export async function setStatus(boardPath, repo, state, opts = {}) {
  const { lastEvent = 'manual', now = () => new Date().toISOString(), ...io } = opts;
  if (!STATES.includes(state)) {
    throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  }
  const board = await readBoard(boardPath, io);
  const at = now();
  const prev = board.repos[repo];
  const events = [{ event: lastEvent, at }, ...(prev?.events ?? [])].slice(0, MAX_EVENTS);
  board.repos[repo] = { status: state, updatedAt: at, lastEvent, events };
  await writeBoard(boardPath, board, io);
  return board;
}
```

Replace the loop body in `initRepos`:

```js
  for (const name of repoNames) {
    if (!board.repos[name]) {
      const at = now();
      board.repos[name] = { status: 'todo', updatedAt: at, lastEvent: 'init', events: [{ event: 'init', at }] };
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, coverage still 100%.

- [ ] **Step 7: Commit**

```bash
git add src/board.js test/board.test.js
git commit -m "feat(board): record bounded per-repo event history"
```

---

### Task 2: Backfill `events` for legacy board files (`readBoard`)

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Update the existing `readBoard` default test and add a backfill test**

Replace `readBoard parses an existing board and fills defaults`:

```js
test('readBoard parses an existing board and backfills an empty events array', async () => {
  const read = async () => JSON.stringify({ repos: { a: { status: 'done' } } });
  assert.deepEqual(await readBoard('/x', { read }), { version: 1, repos: { a: { status: 'done', events: [] } } });
});

test('readBoard backfills events from lastEvent for legacy files', async () => {
  const read = async () => JSON.stringify({ repos: { a: { status: 'done', lastEvent: 'pushed', updatedAt: 'T' } } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board.repos.a.events, [{ event: 'pushed', at: 'T' }]);
});

test('readBoard leaves an existing events array untouched', async () => {
  const events = [{ event: 'x', at: 'T' }];
  const read = async () => JSON.stringify({ repos: { a: { status: 'done', lastEvent: 'x', updatedAt: 'T', events } } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board.repos.a.events, events);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `events` missing on read.

- [ ] **Step 3: Implement backfill in `readBoard`**

Replace `readBoard`:

```js
export async function readBoard(boardPath, { read = readFile } = {}) {
  try {
    const parsed = JSON.parse(await read(boardPath, 'utf8'));
    const board = { version: 1, repos: {}, ...parsed };
    for (const entry of Object.values(board.repos)) {
      if (!Array.isArray(entry.events)) {
        entry.events = entry.lastEvent ? [{ event: entry.lastEvent, at: entry.updatedAt ?? null }] : [];
      }
    }
    return board;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, repos: {} };
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS, coverage 100%.

Note: the `setStatus defaults lastEvent to manual` and `initRepos adds missing repos` tests read `{"repos":{}}` / repos with `lastEvent`, so backfill keeps them consistent — no further edits expected. If any pre-existing assertion now includes `events: []`, update it to match.

- [ ] **Step 5: Commit**

```bash
git add src/board.js test/board.test.js
git commit -m "feat(board): backfill events for legacy board files"
```

---

### Task 3: `GET /api/config` endpoint (`apps/board/server.js`)

**Files:**
- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write failing tests for the endpoint**

Append to `apps/board/server.test.js`:

```js
test('GET /api/config maps repos.json to name -> metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({
    repos: [{ name: 'example-api', url: 'https://h/example-api.git', technologies: ['nestjs'], targets: ['claude'] }],
  }));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, configPath });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await res.json(), {
    repos: { 'example-api': { url: 'https://h/example-api.git', technologies: ['nestjs'], targets: ['claude'] } },
  });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/config returns empty repos when no config is configured', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await res.json(), { repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/config returns empty repos when the config file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, configPath: path.join(dir, 'nope.json') });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await res.json(), { repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — `/api/config` falls through to the SPA handler (returns HTML / 404).

- [ ] **Step 3: Implement `serveConfig` and route it**

In `apps/board/server.js`, add after `serveBoard`:

```js
async function serveConfig(configPath, res) {
  const repos = {};
  if (configPath) {
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8'));
      for (const r of parsed.repos ?? []) {
        if (r?.name) repos[r.name] = { url: r.url, technologies: r.technologies ?? [], targets: r.targets ?? [] };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ repos }));
}
```

Update `createBoardServer` to accept and route `configPath`:

```js
export function createBoardServer({ boardPath, distDir, configPath = null }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      if (url.pathname === '/api/config') return await serveConfig(configPath, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}
```

Update `startFromArgv` to read the config source. Add `config` to the parsed options and pass it through:

```js
  const { values } = parseArgs({
    args: argv,
    options: {
      board: { type: 'string' }, port: { type: 'string', default: '4180' },
      dist: { type: 'string' }, config: { type: 'string' },
    },
  });
  const boardPath = path.resolve(values.board ?? process.env.AI_SYNC_BOARD ?? 'board.json');
  const configSrc = values.config ?? process.env.AI_SYNC_CONFIG ?? null;
  const configPath = configSrc ? path.resolve(configSrc) : null;
  const distDir = values.dist ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
  const server = createBoardServer({ boardPath, distDir, configPath });
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Document the flag in the README**

In `README.md`, under "Board dashboard", add a line to the `npm start` examples:

```bash
npm start -- --config repos.json            # also serve repo metadata at /api/config
```

- [ ] **Step 6: Commit**

```bash
git add apps/board/server.js apps/board/server.test.js README.md
git commit -m "feat(board): serve repo metadata via /api/config"
```

---

## Lot 2 — Readability (C)

### Task 4: Relative-time helper (`useRelativeTime.js`)

**Files:**
- Create: `apps/board/src/useRelativeTime.js`
- Test: `apps/board/src/useRelativeTime.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/useRelativeTime.test.js`:

```js
import { test, expect } from 'vitest';
import { relativeTime } from './useRelativeTime.js';

const base = Date.parse('2026-06-21T10:00:00.000Z');

test('formats seconds, minutes, hours and days', () => {
  expect(relativeTime('2026-06-21T09:59:50.000Z', base)).toBe('il y a 10 s');
  expect(relativeTime('2026-06-21T09:57:00.000Z', base)).toBe('il y a 3 min');
  expect(relativeTime('2026-06-21T07:00:00.000Z', base)).toBe('il y a 3 h');
  expect(relativeTime('2026-06-19T10:00:00.000Z', base)).toBe('il y a 2 j');
});

test('returns empty string for a missing timestamp', () => {
  expect(relativeTime(null, base)).toBe('');
});

test('clamps future timestamps to 0 s', () => {
  expect(relativeTime('2026-06-21T10:00:30.000Z', base)).toBe('il y a 0 s');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper and a ticking composable**

Create `apps/board/src/useRelativeTime.js`:

```js
import { ref, onUnmounted } from 'vue';

export function relativeTime(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

// Reactive "now" that updates on an interval, for live-refreshing relative times.
export function useNow(intervalMs = 1000) {
  const now = ref(Date.now());
  const timer = setInterval(() => { now.value = Date.now(); }, intervalMs);
  onUnmounted(() => clearInterval(timer));
  return now;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useRelativeTime.js apps/board/src/useRelativeTime.test.js
git commit -m "feat(board): add relative-time helper"
```

---

### Task 5: Card relative time + question highlight + click (`Card.vue`, `Column.vue`)

**Files:**
- Modify: `apps/board/src/Card.vue`, `apps/board/src/Column.vue`
- Test: `apps/board/src/Card.test.js`

- [ ] **Step 1: Write failing tests for the card**

Create `apps/board/src/Card.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Card from './Card.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');

test('renders the repo name and a relative time', () => {
  const repo = { status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T09:59:00.000Z' };
  const w = mount(Card, { props: { name: 'example-api', repo, now } });
  expect(w.text()).toContain('example-api');
  expect(w.text()).toContain('il y a 1 min');
});

test('highlights a question card', () => {
  const repo = { status: 'question', lastEvent: 'Stop', updatedAt: '2026-06-21T10:00:00.000Z' };
  const w = mount(Card, { props: { name: 'oc-auth', repo, now } });
  expect(w.classes().join(' ')).toContain('ring-amber-200');
});

test('emits "open" with the repo name on click', async () => {
  const repo = { status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T10:00:00.000Z' };
  const w = mount(Card, { props: { name: 'example-api', repo, now } });
  await w.trigger('click');
  expect(w.emitted('open')[0]).toEqual(['example-api']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — no relative time / no highlight / no emit.

- [ ] **Step 3: Implement `Card.vue`**

Replace `apps/board/src/Card.vue`:

```vue
<script setup>
import { computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';

const props = defineProps({
  name: { type: String, required: true },
  repo: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
});
defineEmits(['open']);

const isQuestion = computed(() => props.repo.status === 'question');
const when = computed(() => relativeTime(props.repo.updatedAt, props.now));
</script>

<template>
  <button
    type="button"
    @click="$emit('open', name)"
    :class="['w-full text-left rounded-md bg-white shadow-sm border p-3 transition',
             isQuestion ? 'border-amber-400 ring-4 ring-amber-200' : 'border-slate-200 hover:border-slate-300']"
  >
    <div class="font-medium text-slate-800">{{ name }}</div>
    <div class="mt-1 text-xs text-slate-500">{{ repo.lastEvent }} · {{ when }}</div>
  </button>
</template>
```

- [ ] **Step 4: Forward `now` and `open` through `Column.vue`**

Replace `apps/board/src/Column.vue`:

```vue
<script setup>
import Card from './Card.vue';
defineProps({
  title: { type: String, required: true },
  accent: { type: String, default: 'bg-slate-100' },
  entries: { type: Array, required: true }, // [{ name, repo }]
  now: { type: Number, default: () => Date.now() },
});
defineEmits(['open']);
</script>

<template>
  <section class="flex-1 min-w-[14rem]">
    <h2 :class="['rounded-t-md px-3 py-2 text-sm font-semibold text-slate-700', accent]">
      {{ title }} <span class="text-slate-400">({{ entries.length }})</span>
    </h2>
    <div class="flex flex-col gap-2 bg-slate-50 p-2 rounded-b-md min-h-[4rem]">
      <Card v-for="e in entries" :key="e.name" :name="e.name" :repo="e.repo" :now="now" @open="$emit('open', $event)" />
    </div>
  </section>
</template>
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run test:board`
Expected: Card tests PASS. (The existing `App.test.js` still passes: cards still render names and columns are still `section` elements.)

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/Card.vue apps/board/src/Column.vue apps/board/src/Card.test.js
git commit -m "feat(board): relative time, question highlight, clickable cards"
```

---

### Task 6: Summary header (`SummaryHeader.vue`)

**Files:**
- Create: `apps/board/src/SummaryHeader.vue`
- Test: `apps/board/src/SummaryHeader.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/SummaryHeader.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SummaryHeader from './SummaryHeader.vue';

const repos = {
  a: { status: 'todo' }, b: { status: 'inprogress' },
  c: { status: 'question' }, d: { status: 'done' }, e: { status: 'done' },
};

test('shows total and per-status counts', () => {
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.text()).toContain('5');         // total
  expect(w.text()).toContain('1 Question');
  expect(w.text()).toContain('2 Done');
});

test('computes the done percentage', () => {
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.text()).toContain('40 %');       // 2 of 5
  expect(w.get('[data-test=progress]').attributes('style')).toContain('40%');
});

test('handles an empty board without dividing by zero', () => {
  const w = mount(SummaryHeader, { props: { repos: {} } });
  expect(w.text()).toContain('0 %');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SummaryHeader.vue`**

Create `apps/board/src/SummaryHeader.vue`:

```vue
<script setup>
import { computed } from 'vue';

const props = defineProps({ repos: { type: Object, required: true } });

const counts = computed(() => {
  const c = { todo: 0, inprogress: 0, question: 0, done: 0 };
  for (const r of Object.values(props.repos)) if (c[r.status] !== undefined) c[r.status] += 1;
  return c;
});
const total = computed(() => Object.keys(props.repos).length);
const percentDone = computed(() => (total.value ? Math.round((counts.value.done / total.value) * 100) : 0));
</script>

<template>
  <div class="bg-white border border-slate-200 rounded-lg px-4 py-3 mb-4">
    <div class="flex flex-wrap gap-4 text-sm text-slate-600 mb-2">
      <span><b class="text-slate-800">{{ total }}</b> repos</span>
      <span>· <b>{{ counts.todo }}</b> To do</span>
      <span>· <b>{{ counts.inprogress }}</b> In progress</span>
      <span class="text-amber-700">· <b>{{ counts.question }}</b> Question</span>
      <span class="text-emerald-700">· <b>{{ counts.done }}</b> Done</span>
    </div>
    <div class="h-2 bg-slate-200 rounded overflow-hidden">
      <div data-test="progress" class="h-full bg-emerald-500" :style="{ width: percentDone + '%' }"></div>
    </div>
    <div class="text-xs text-slate-400 mt-1">{{ percentDone }} % terminé</div>
  </div>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/SummaryHeader.vue apps/board/src/SummaryHeader.test.js
git commit -m "feat(board): summary header with counts and progress"
```

---

### Task 7: Filter bar (`FilterBar.vue`)

**Files:**
- Create: `apps/board/src/FilterBar.vue`
- Test: `apps/board/src/FilterBar.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/FilterBar.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FilterBar from './FilterBar.vue';

test('emits name updates as the user types', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', technologies: ['nestjs', 'postgres'] } });
  await w.get('[data-test=search]').setValue('example-api');
  expect(w.emitted('update:name')[0]).toEqual(['example-api']);
});

test('lists technologies and emits tech selection', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', technologies: ['nestjs', 'postgres'] } });
  const options = w.findAll('option').map((o) => o.text());
  expect(options).toContain('nestjs');
  expect(options).toContain('postgres');
  await w.get('[data-test=tech]').setValue('nestjs');
  expect(w.emitted('update:tech')[0]).toEqual(['nestjs']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FilterBar.vue`**

Create `apps/board/src/FilterBar.vue`:

```vue
<script setup>
defineProps({
  name: { type: String, default: '' },
  tech: { type: String, default: '' },
  technologies: { type: Array, default: () => [] },
});
defineEmits(['update:name', 'update:tech']);
</script>

<template>
  <div class="flex items-center gap-2">
    <input
      data-test="search"
      :value="name"
      @input="$emit('update:name', $event.target.value)"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
    />
    <select
      data-test="tech"
      :value="tech"
      @change="$emit('update:tech', $event.target.value)"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-600"
    >
      <option value="">techno : toutes</option>
      <option v-for="t in technologies" :key="t" :value="t">{{ t }}</option>
    </select>
  </div>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/FilterBar.vue apps/board/src/FilterBar.test.js
git commit -m "feat(board): name + technology filter bar"
```

---

## Lot 3 — Alerts (A) & Detail (D)

### Task 8: Transition diff + freshness in `useBoard.js`

**Files:**
- Modify: `apps/board/src/useBoard.js`
- Test: `apps/board/src/useBoard.test.js`

- [ ] **Step 1: Write failing tests for transitions and connection state**

Append to `apps/board/src/useBoard.test.js`:

```js
test('useBoard reports no transitions on the first fetch (baseline)', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ repos: { a: { status: 'question' } } }) });
  const { transitions, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(transitions.value).toEqual([]);
  stop();
});

test('useBoard detects transitions into question/done on later fetches', async () => {
  const responses = [
    { repos: { a: { status: 'inprogress' }, b: { status: 'todo' } } },
    { repos: { a: { status: 'question' }, b: { status: 'done' } } },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve({ json: async () => responses.shift() }));
  const { transitions, refresh, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(transitions.value).toEqual([{ name: 'a', status: 'question' }, { name: 'b', status: 'done' }]);
  stop();
});

test('useBoard sets connected=false on a fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { connected, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(connected.value).toBe(false);
  stop();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — `transitions`/`connected` undefined.

- [ ] **Step 3: Implement transition diff + freshness**

Replace `apps/board/src/useBoard.js`:

```js
import { ref, onUnmounted } from 'vue';

const NOTIFY_STATES = ['question', 'done'];

function diffTransitions(prev, next) {
  const out = [];
  for (const [name, r] of Object.entries(next)) {
    if (NOTIFY_STATES.includes(r.status) && prev[name]?.status !== r.status) {
      out.push({ name, status: r.status });
    }
  }
  return out;
}

export function useBoard({ intervalMs = 3000, fetchImpl = fetch } = {}) {
  const repos = ref({});
  const error = ref(null);
  const transitions = ref([]);
  const connected = ref(true);
  let prev = null; // null until the first successful fetch establishes a baseline

  async function refresh() {
    try {
      const res = await fetchImpl('/api/board');
      const data = await res.json();
      const next = data.repos ?? {};
      transitions.value = prev ? diffTransitions(prev, next) : [];
      prev = next;
      repos.value = next;
      error.value = null;
      connected.value = true;
    } catch (err) {
      error.value = err;
      connected.value = false;
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  function stop() { clearInterval(timer); }
  onUnmounted(stop);

  return { repos, error, transitions, connected, refresh, stop };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS (existing useBoard tests still pass — `repos` shape unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useBoard.js apps/board/src/useBoard.test.js
git commit -m "feat(board): detect status transitions and connection state"
```

---

### Task 9: Config fetch composable (`useConfig.js`)

**Files:**
- Create: `apps/board/src/useConfig.js`
- Test: `apps/board/src/useConfig.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/useConfig.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useConfig } from './useConfig.js';

test('fetches /api/config once and exposes repos', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ repos: { a: { url: 'u', technologies: ['nestjs'], targets: [] } } }) });
  const { repos } = useConfig({ fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/config');
  expect(repos.value.a.url).toBe('u');
});

test('degrades to empty repos on fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { repos } = useConfig({ fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(repos.value).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useConfig.js`**

Create `apps/board/src/useConfig.js`:

```js
import { ref } from 'vue';

export function useConfig({ fetchImpl = fetch } = {}) {
  const repos = ref({});
  async function load() {
    try {
      const res = await fetchImpl('/api/config');
      const data = await res.json();
      repos.value = data.repos ?? {};
    } catch {
      repos.value = {};
    }
  }
  load();
  return { repos, load };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useConfig.js apps/board/src/useConfig.test.js
git commit -m "feat(board): fetch repo metadata via useConfig"
```

---

### Task 10: Notifications, sound toggle, title badge (`useNotifications.js`)

**Files:**
- Create: `apps/board/src/useNotifications.js`
- Test: `apps/board/src/useNotifications.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/useNotifications.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { useNotifications } from './useNotifications.js';

function fakeNotifier(permission = 'granted') {
  const instances = [];
  class N { constructor(title, opts) { instances.push({ title, opts }); } }
  N.permission = permission;
  N.requestPermission = vi.fn().mockResolvedValue('granted');
  N.instances = instances;
  return N;
}
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('fires a notification for each transition when permission granted', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('granted');
  const playSound = vi.fn();
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' }, playSound });
  transitions.value = [{ name: 'oc-auth', status: 'question' }];
  await nextTick();
  expect(notifier.instances.length).toBe(1);
  expect(notifier.instances[0].title).toContain('oc-auth');
  expect(playSound).not.toHaveBeenCalled(); // sound off by default
});

test('requestPermission delegates to the Notification API', async () => {
  const notifier = fakeNotifier('default');
  const { requestPermission, permission } = useNotifications(ref([]), ref(0), { notifier, storage: fakeStorage(), doc: { title: '' } });
  await requestPermission();
  expect(notifier.requestPermission).toHaveBeenCalled();
  expect(permission.value).toBe('granted');
});

test('sound toggle persists and gates playSound', async () => {
  const transitions = ref([]);
  const storage = fakeStorage();
  const playSound = vi.fn();
  const { toggleSound, soundOn } = useNotifications(transitions, ref(0), { notifier: fakeNotifier('granted'), storage, doc: { title: '' }, playSound });
  toggleSound();
  expect(soundOn.value).toBe(true);
  expect(storage.getItem('ai-sync:sound')).toBe('1');
  transitions.value = [{ name: 'a', status: 'done' }];
  await nextTick();
  expect(playSound).toHaveBeenCalled();
});

test('updates the document title badge from the question count', async () => {
  const doc = { title: '' };
  const count = ref(0);
  useNotifications(ref([]), count, { notifier: fakeNotifier('granted'), storage: fakeStorage(), doc });
  await nextTick();
  expect(doc.title).toBe('ai-sync board');
  count.value = 2;
  await nextTick();
  expect(doc.title).toBe('(2) ai-sync board');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useNotifications.js`**

Create `apps/board/src/useNotifications.js`:

```js
import { ref, watch } from 'vue';

const SOUND_KEY = 'ai-sync:sound';

function defaultPlaySound() {
  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch { /* audio unavailable — ignore */ }
}

function bodyFor(status) {
  return status === 'question' ? 'Un agent attend ton input' : 'Travail terminé';
}

export function useNotifications(transitions, questionCount, {
  notifier = globalThis.Notification,
  storage = globalThis.localStorage,
  doc = globalThis.document,
  playSound = defaultPlaySound,
} = {}) {
  const permission = ref(notifier ? notifier.permission : 'unsupported');
  const soundOn = ref(storage?.getItem(SOUND_KEY) === '1');

  async function requestPermission() {
    if (!notifier) return;
    permission.value = await notifier.requestPermission();
  }
  function toggleSound() {
    soundOn.value = !soundOn.value;
    storage?.setItem(SOUND_KEY, soundOn.value ? '1' : '0');
  }

  watch(transitions, (list) => {
    if (!list || list.length === 0) return;
    if (notifier && permission.value === 'granted') {
      for (const t of list) new notifier(`${t.name} → ${t.status}`, { body: bodyFor(t.status) });
    }
    if (soundOn.value) playSound();
  });

  watch(questionCount, (n) => {
    if (doc) doc.title = n > 0 ? `(${n}) ai-sync board` : 'ai-sync board';
  }, { immediate: true });

  return { permission, soundOn, requestPermission, toggleSound };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useNotifications.js apps/board/src/useNotifications.test.js
git commit -m "feat(board): browser notifications, sound toggle, title badge"
```

---

### Task 11: Detail side panel (`RepoDetail.vue`)

**Files:**
- Create: `apps/board/src/RepoDetail.vue`
- Test: `apps/board/src/RepoDetail.test.js`

- [ ] **Step 1: Write failing tests**

Create `apps/board/src/RepoDetail.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RepoDetail from './RepoDetail.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');
const repo = {
  status: 'question', lastEvent: 'waiting', updatedAt: '2026-06-21T10:00:00.000Z',
  events: [
    { event: 'waiting input', at: '2026-06-21T09:59:48.000Z' },
    { event: 'edit src/', at: '2026-06-21T09:57:00.000Z' },
  ],
};
const meta = { url: 'https://h/oc-auth.git', technologies: ['nestjs'], targets: ['claude'] };

test('renders url, technologies and the event timeline', () => {
  const w = mount(RepoDetail, { props: { name: 'oc-auth', repo, meta, now } });
  expect(w.get('a').attributes('href')).toBe('https://h/oc-auth.git');
  expect(w.text()).toContain('nestjs');
  expect(w.text()).toContain('waiting input');
  expect(w.text()).toContain('il y a 12 s');
});

test('renders nothing when name is null', () => {
  const w = mount(RepoDetail, { props: { name: null, repo: null, meta: null, now } });
  expect(w.find('aside').exists()).toBe(false);
});

test('emits close on overlay click and on Escape', async () => {
  const w = mount(RepoDetail, { props: { name: 'oc-auth', repo, meta, now }, attachTo: document.body });
  await w.get('[data-test=overlay]').trigger('click');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(w.emitted('close').length).toBeGreaterThanOrEqual(2);
  w.unmount();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RepoDetail.vue`**

Create `apps/board/src/RepoDetail.vue`:

```vue
<script setup>
import { onMounted, onUnmounted } from 'vue';
import { relativeTime } from './useRelativeTime.js';

const props = defineProps({
  name: { type: String, default: null },
  repo: { type: Object, default: null },
  meta: { type: Object, default: null },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['close']);

function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="name" class="fixed inset-0 z-20">
    <div data-test="overlay" class="absolute inset-0 bg-slate-900/30" @click="emit('close')"></div>
    <aside class="absolute right-0 top-0 h-full w-80 bg-white shadow-xl p-4 overflow-y-auto">
      <button class="float-right text-slate-400 hover:text-slate-600" @click="emit('close')">✕</button>
      <h2 class="font-bold text-slate-800">{{ name }}</h2>
      <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
         class="text-sm text-blue-600 underline break-all">{{ meta.url }}</a>
      <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
        <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs bg-slate-100 px-2 py-0.5 rounded">{{ t }}</span>
        <span v-for="t in (meta.targets || [])" :key="t" class="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{{ t }}</span>
      </div>
      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">Historique</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (repo?.events || [])" :key="i" class="text-xs text-slate-600">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/RepoDetail.vue apps/board/src/RepoDetail.test.js
git commit -m "feat(board): repo detail side panel with event timeline"
```

---

### Task 12: Wire everything in `App.vue`

**Files:**
- Modify: `apps/board/src/App.vue`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Update `App.test.js` to route both endpoints and assert the new chrome**

Replace `apps/board/src/App.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import App from './App.vue';

function routedFetch() {
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/config') {
      return Promise.resolve({ json: async () => ({ repos: { a: { url: 'u', technologies: ['nestjs'], targets: [] } } }) });
    }
    return Promise.resolve({ json: async () => ({
      version: 1,
      repos: {
        a: { status: 'todo', lastEvent: 'init', updatedAt: 'T', events: [] },
        b: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', events: [] },
        c: { status: 'question', lastEvent: 'Notification', updatedAt: 'T', events: [] },
      },
    }) });
  });
}

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }

test('App groups repos into the four columns', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  const columns = wrapper.findAll('section');
  expect(columns).toHaveLength(4);
  expect(columns[2].text()).toContain('(2)');
  expect(wrapper.text()).toContain('a');
  expect(wrapper.text()).toContain('b');
});

test('App renders the summary header and filter bar', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  expect(wrapper.text()).toContain('repos');
  expect(wrapper.find('[data-test=search]').exists()).toBe(true);
});

test('clicking a card opens the detail panel', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  await wrapper.get('section button').trigger('click'); // first card (cards are buttons inside a column section)
  expect(wrapper.find('aside').exists()).toBe(true);
});

test('typing in the search filters the cards', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  await wrapper.get('[data-test=search]').setValue('b');
  await nextTick();
  expect(wrapper.text()).toContain('b');
  expect(wrapper.text()).not.toContain('Notification'); // card 'c' filtered out
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — App lacks the header, filter bar, and detail panel.

- [ ] **Step 3: Implement `App.vue`**

Replace `apps/board/src/App.vue`:

```vue
<script setup>
import { computed, ref } from 'vue';
import Column from './Column.vue';
import SummaryHeader from './SummaryHeader.vue';
import FilterBar from './FilterBar.vue';
import RepoDetail from './RepoDetail.vue';
import { useBoard } from './useBoard.js';
import { useConfig } from './useConfig.js';
import { useNotifications } from './useNotifications.js';
import { useNow } from './useRelativeTime.js';

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});
const fetchImpl = props.fetchImpl ?? fetch;

const { repos, transitions, connected } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
const { repos: config } = useConfig({ fetchImpl });
const now = useNow();

const nameFilter = ref('');
const techFilter = ref('');
const selected = ref(null);

const questionCount = computed(() => Object.values(repos.value).filter((r) => r.status === 'question').length);
const { permission, soundOn, requestPermission, toggleSound } = useNotifications(transitions, questionCount, {});

const technologies = computed(() => {
  const set = new Set();
  for (const meta of Object.values(config.value)) for (const t of meta.technologies ?? []) set.add(t);
  return [...set].sort();
});

const COLUMNS = [
  { status: 'todo', title: 'To do', accent: 'bg-slate-200' },
  { status: 'inprogress', title: 'In progress', accent: 'bg-blue-200' },
  { status: 'question', title: 'Question', accent: 'bg-amber-300' },
  { status: 'done', title: 'Done', accent: 'bg-emerald-200' },
];

const filtered = computed(() => {
  const out = {};
  for (const [name, repo] of Object.entries(repos.value)) {
    if (nameFilter.value && !name.toLowerCase().includes(nameFilter.value.toLowerCase())) continue;
    if (techFilter.value && !(config.value[name]?.technologies ?? []).includes(techFilter.value)) continue;
    out[name] = repo;
  }
  return out;
});

function entriesFor(status) {
  return Object.entries(filtered.value)
    .filter(([, r]) => r.status === status)
    .map(([name, repo]) => ({ name, repo }));
}
const grouped = computed(() => COLUMNS.map((c) => ({ ...c, entries: entriesFor(c.status) })));

const selectedRepo = computed(() => (selected.value ? repos.value[selected.value] : null));
const selectedMeta = computed(() => (selected.value ? config.value[selected.value] ?? null : null));
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-4">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <h1 class="text-lg font-bold text-slate-800">ai-sync · workspace board</h1>
      <div class="flex items-center gap-2">
        <FilterBar
          :name="nameFilter" :tech="techFilter" :technologies="technologies"
          @update:name="nameFilter = $event" @update:tech="techFilter = $event"
        />
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-amber-700">⚠ déconnecté — nouvelle tentative au prochain poll…</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-slate-500">Notifications bloquées par le navigateur.</p>

    <SummaryHeader :repos="repos" />

    <div class="flex gap-3">
      <Column
        v-for="c in grouped" :key="c.status"
        :title="c.title" :accent="c.accent" :entries="c.entries" :now="now"
        @open="selected = $event"
      />
    </div>

    <RepoDetail
      :name="selected" :repo="selectedRepo" :meta="selectedMeta" :now="now"
      @close="selected = null"
    />
  </main>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS (all front-end + server tests).

- [ ] **Step 5: Run the full root suite to confirm the coverage gate**

Run: `npm test`
Expected: PASS, `src/` coverage 100%.

- [ ] **Step 6: Update the README board section**

In `README.md`, under "Board dashboard", note the new capabilities in prose (one or two sentences): event history in `board.json`, the `--config` flag for `/api/config`, browser notifications on `question`/`done`, summary header, name/technology filters, and the click-through detail panel.

- [ ] **Step 7: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/App.test.js README.md
git commit -m "feat(board): assemble alerts, filters, summary, and detail panel"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** A → Tasks 8, 10, 12 (+ highlight in 5); C → Tasks 4–7, 12; D → Tasks 1–3, 9, 11, 12. Degraded mode → Tasks 3, 9, 12. Freshness indicator → Tasks 8, 12.
- **`board.json` `version` stays `1`** (additive). `MAX_EVENTS = 20` is the single source of the history cap.
- **Zero-dependency server preserved:** `/api/config` parses `repos.json` inline; it does NOT import `src/config.js`.
- **Consistent names across tasks:** `transitions` `[{ name, status }]`, `connected`, `useConfig().repos`, `useNotifications(transitions, questionCount, deps)`, `relativeTime(iso, nowMs)`, `useNow()`.
```
