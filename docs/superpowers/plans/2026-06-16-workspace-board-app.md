# Workspace Board App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only kanban board (Vue 3 + Tailwind) that displays each workspace repo's status by polling a small zero-dep Node server which serves `board.json`.

**Architecture:** `apps/board/` is a self-contained sub-package. `apps/board/server.js` is a native-`http` server exposing `GET /api/board` (reads `board.json`) and serving the built front-end from `dist/`. The Vue front-end polls `/api/board` every few seconds and renders four columns. The `ai-workspace board` subcommand (in `src/`) spawns the server. The server only reads the interface produced by the status-tracking plan: `board.json` = `{ version: 1, repos: { <name>: { status, updatedAt, lastEvent } } }`.

**Tech Stack:** Node.js ≥22 native `http` (server, zero runtime deps), Vite + Vue 3 + Tailwind (front-end), Vitest (front-end tests). The root `npm test` coverage gate covers only `src/**`; `apps/board/**` is tested separately and not coverage-gated.

**Prerequisite:** the "Workspace Status Tracking" plan is implemented (`board.json` exists / is written).

---

## File Structure

- Create: `apps/board/package.json` — sub-package (scripts: dev, build, test, start).
- Create: `apps/board/server.js` — `createBoardServer()` + a runnable entry (`parseArgs`, `listen`).
- Create: `apps/board/server.test.js` — `node:test` server tests.
- Create: `apps/board/vite.config.js`, `apps/board/tailwind.config.js`, `apps/board/postcss.config.js`, `apps/board/index.html`.
- Create: `apps/board/src/main.js`, `apps/board/src/style.css` (Tailwind directives).
- Create: `apps/board/src/useBoard.js` — polling composable.
- Create: `apps/board/src/App.vue`, `apps/board/src/Column.vue`, `apps/board/src/Card.vue`.
- Create: `apps/board/src/useBoard.test.js`, `apps/board/src/App.test.js` (Vitest).
- Modify: `src/workspace.js` — add the `board` subcommand (spawns the server).
- Modify: `test/workspace.test.js` — test the `board` subcommand spawns correctly.

---

## Task 1: Scaffold `apps/board` package

**Files:**
- Create: `apps/board/package.json`, `apps/board/vite.config.js`, `apps/board/tailwind.config.js`, `apps/board/postcss.config.js`, `apps/board/index.html`, `apps/board/src/main.js`, `apps/board/src/style.css`

- [ ] **Step 1: Create `apps/board/package.json`**

```json
{
  "name": "@ai-sync/board",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "node server.js",
    "test": "node --test server.test.js && vitest run"
  },
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.1.0",
    "@vue/test-utils": "^2.4.6",
    "autoprefixer": "^10.4.0",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create the build/config files**

`apps/board/vite.config.js`:

```js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: { environment: 'jsdom' },
});
```

`apps/board/tailwind.config.js`:

```js
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: { extend: {} },
  plugins: [],
};
```

`apps/board/postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`apps/board/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-sync board</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

`apps/board/src/style.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`apps/board/src/main.js`:

```js
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
```

- [ ] **Step 3: Install deps**

Run: `cd apps/board && pnpm install`
Expected: dependencies installed, `node_modules` created.

- [ ] **Step 4: Commit**

```bash
rtk git add apps/board/package.json apps/board/vite.config.js apps/board/tailwind.config.js apps/board/postcss.config.js apps/board/index.html apps/board/src/main.js apps/board/src/style.css
rtk git commit -m "chore: scaffold apps/board (vite + vue + tailwind)"
```

---

## Task 2: Server — `createBoardServer` and `GET /api/board`

**Files:**
- Create: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/board/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoardServer } from './server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('GET /api/board returns the board JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  await writeFile(boardPath, JSON.stringify({ version: 1, repos: { a: { status: 'todo' } } }));
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1, repos: { a: { status: 'todo' } } });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/board returns an empty board when the file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'nope.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.deepEqual(await res.json(), { version: 1, repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/board && node --test server.test.js`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// apps/board/server.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveBoard(boardPath, res) {
  let body;
  try {
    body = await readFile(boardPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    body = JSON.stringify({ version: 1, repos: {} });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

export function createBoardServer({ boardPath, distDir }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}

async function serveStatic(distDir, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(distDir, rel);
  if (!file.startsWith(path.resolve(distDir))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // SPA fallback: serve index.html for unknown routes
    const index = await readFile(path.join(distDir, 'index.html')).catch(() => null);
    if (index) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(index); }
    else { res.writeHead(404); res.end('not found'); }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/board && node --test server.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/board/server.js apps/board/server.test.js
rtk git commit -m "feat: board server with /api/board endpoint"
```

---

## Task 3: Server — static serving test + runnable entry

**Files:**
- Modify: `apps/board/server.js` (add `main`/listen entry)
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to apps/board/server.test.js
test('serves a static file from distDir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>board</h1>');
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.equal(await res.text(), '<h1>board</h1>');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('unknown path falls back to index.html (SPA)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>spa</h1>');
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/anything`);
  assert.equal(await res.text(), '<h1>spa</h1>');
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/board && node --test server.test.js`
Expected: the SPA/static tests should PASS already from Task 2's `serveStatic`. If they pass, this step confirms behavior; if the fallback path is missing, fix `serveStatic`.

- [ ] **Step 3: Add the runnable entry**

Append to `apps/board/server.js`:

```js
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export function startFromArgv(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { board: { type: 'string' }, port: { type: 'string', default: '4173' }, dist: { type: 'string' } },
  });
  const boardPath = values.board ?? process.env.AI_SYNC_BOARD;
  if (!boardPath) throw new Error('board server needs --board <path> or AI_SYNC_BOARD');
  const distDir = values.dist ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
  const server = createBoardServer({ boardPath, distDir });
  server.listen(Number(values.port), () => log(`board on http://localhost:${values.port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startFromArgv(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/board && node --test server.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/board/server.js apps/board/server.test.js
rtk git commit -m "feat: board server static serving + CLI entry"
```

---

## Task 4: Front-end — `useBoard` polling composable

**Files:**
- Create: `apps/board/src/useBoard.js`
- Test: `apps/board/src/useBoard.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/board/src/useBoard.test.js
import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useBoard } from './useBoard.js';

test('useBoard fetches immediately and exposes repos', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 1, repos: { a: { status: 'todo' } } }) });
  const { repos, stop } = useBoard({ intervalMs: 1000, fetchImpl });
  await nextTick();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/board');
  expect(repos.value).toEqual({ a: { status: 'todo' } });
  stop();
});

test('useBoard polls on the interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 1, repos: {} }) });
  const { stop } = useBoard({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3); // immediate + 2 ticks
  stop();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/board && npx vitest run src/useBoard.test.js`
Expected: FAIL — `Cannot find module './useBoard.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// apps/board/src/useBoard.js
import { ref, onUnmounted } from 'vue';

export function useBoard({ intervalMs = 3000, fetchImpl = fetch } = {}) {
  const repos = ref({});
  const error = ref(null);

  async function refresh() {
    try {
      const res = await fetchImpl('/api/board');
      const data = await res.json();
      repos.value = data.repos ?? {};
      error.value = null;
    } catch (err) {
      error.value = err;
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  function stop() { clearInterval(timer); }
  onUnmounted(stop);

  return { repos, error, refresh, stop };
}
```

Note: `onUnmounted` is a no-op outside a component setup; the tests call `stop()` explicitly, which is why `stop` is returned.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/board && npx vitest run src/useBoard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/board/src/useBoard.js apps/board/src/useBoard.test.js
rtk git commit -m "feat: useBoard polling composable"
```

---

## Task 5: Front-end — `Card.vue` and `Column.vue`

**Files:**
- Create: `apps/board/src/Card.vue`, `apps/board/src/Column.vue`

- [ ] **Step 1: Create `apps/board/src/Card.vue`**

```vue
<script setup>
defineProps({ name: { type: String, required: true }, repo: { type: Object, required: true } });
</script>

<template>
  <div class="rounded-md bg-white shadow-sm border border-slate-200 p-3">
    <div class="font-medium text-slate-800">{{ name }}</div>
    <div class="mt-1 text-xs text-slate-500">{{ repo.lastEvent }} · {{ repo.updatedAt }}</div>
  </div>
</template>
```

- [ ] **Step 2: Create `apps/board/src/Column.vue`**

```vue
<script setup>
import Card from './Card.vue';
defineProps({
  title: { type: String, required: true },
  accent: { type: String, default: 'bg-slate-100' },
  entries: { type: Array, required: true }, // [{ name, repo }]
});
</script>

<template>
  <section class="flex-1 min-w-[14rem]">
    <h2 :class="['rounded-t-md px-3 py-2 text-sm font-semibold text-slate-700', accent]">
      {{ title }} <span class="text-slate-400">({{ entries.length }})</span>
    </h2>
    <div class="flex flex-col gap-2 bg-slate-50 p-2 rounded-b-md min-h-[4rem]">
      <Card v-for="e in entries" :key="e.name" :name="e.name" :repo="e.repo" />
    </div>
  </section>
</template>
```

- [ ] **Step 3: Commit**

```bash
rtk git add apps/board/src/Card.vue apps/board/src/Column.vue
rtk git commit -m "feat: board Card and Column components"
```

---

## Task 6: Front-end — `App.vue` (four columns) + test

**Files:**
- Create: `apps/board/src/App.vue`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/board/src/App.test.js
import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import App from './App.vue';

test('App groups repos into the four columns', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    json: async () => ({
      version: 1,
      repos: {
        a: { status: 'todo', lastEvent: 'init', updatedAt: 'T' },
        b: { status: 'question', lastEvent: 'Stop', updatedAt: 'T' },
        c: { status: 'question', lastEvent: 'Notification', updatedAt: 'T' },
      },
    }),
  });
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await nextTick();
  await Promise.resolve();
  await nextTick();
  const columns = wrapper.findAll('section');
  expect(columns).toHaveLength(4);
  // question column (index 2) shows 2 cards
  expect(columns[2].text()).toContain('(2)');
  expect(wrapper.text()).toContain('a');
  expect(wrapper.text()).toContain('b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/board && npx vitest run src/App.test.js`
Expected: FAIL — `Cannot find module './App.vue'`.

- [ ] **Step 3: Write minimal implementation**

```vue
<!-- apps/board/src/App.vue -->
<script setup>
import { computed } from 'vue';
import Column from './Column.vue';
import { useBoard } from './useBoard.js';

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});

const { repos } = useBoard({ intervalMs: props.intervalMs, fetchImpl: props.fetchImpl ?? fetch });

const COLUMNS = [
  { status: 'todo', title: 'To do', accent: 'bg-slate-200' },
  { status: 'inprogress', title: 'In progress', accent: 'bg-blue-200' },
  { status: 'question', title: 'Question', accent: 'bg-amber-300' },
  { status: 'done', title: 'Done', accent: 'bg-emerald-200' },
];

function entriesFor(status) {
  return Object.entries(repos.value)
    .filter(([, r]) => r.status === status)
    .map(([name, repo]) => ({ name, repo }));
}

const grouped = computed(() => COLUMNS.map((c) => ({ ...c, entries: entriesFor(c.status) })));
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-4">
    <h1 class="text-lg font-bold text-slate-800 mb-4">ai-sync · workspace board</h1>
    <div class="flex gap-3">
      <Column v-for="c in grouped" :key="c.status" :title="c.title" :accent="c.accent" :entries="c.entries" />
    </div>
  </main>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/board && npx vitest run src/App.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the build works**

Run: `cd apps/board && pnpm build`
Expected: `dist/` produced with `index.html` and assets.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/board/src/App.vue apps/board/src/App.test.js
rtk git commit -m "feat: board App with four kanban columns"
```

---

## Task 7: `ai-workspace board` subcommand spawns the server

**Files:**
- Modify: `src/workspace.js` (add `runBoard`; route `board` in `main`)
- Test: `test/workspace.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/workspace.test.js
test('main routes the board subcommand and spawns the server', async () => {
  const spawned = [];
  const code = await main(['board', '--board', '/b.json', '--port', '5000'], {
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; },
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'node');
  assert.ok(spawned[0].args[0].endsWith(path.join('apps', 'board', 'server.js')));
  assert.deepEqual(spawned[0].args.slice(1), ['--board', path.resolve('/b.json'), '--port', '5000']);
});

test('board subcommand defaults the port to 4173', async () => {
  let received;
  await main(['board', '--board', '/b.json'], {
    spawn: (_c, args) => { received = args; return { unref() {} }; }, logger: silentLogger(),
  });
  assert.deepEqual(received.slice(-2), ['--port', '4173']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workspace.test.js`
Expected: FAIL — `board` subcommand not routed.

- [ ] **Step 3: Write minimal implementation**

In `src/workspace.js`, add the import:

```js
import { spawn as defaultSpawn } from 'node:child_process';
```

Route it in `main` (alongside the `status` route from the previous plan):

```js
  if (sub === 'board') return runBoard(rest, deps);
```

Add the handler:

```js
async function runBoard(argv, deps = {}) {
  const { spawn = defaultSpawn, logger = console } = deps;
  const { values } = parseArgs({
    args: argv,
    options: { board: { type: 'string' }, port: { type: 'string', default: '4173' } },
  });
  const boardPath = resolveBoardPath({ board: values.board });
  const serverPath = fileURLToPath(new URL('../apps/board/server.js', import.meta.url));
  const child = spawn('node', [serverPath, '--board', boardPath, '--port', values.port], { stdio: 'inherit' });
  child.unref?.();
  logger.log(`board server on http://localhost:${values.port}`);
  return 0;
}
```

(`resolveBoardPath` and `fileURLToPath` are already imported by the status-tracking plan.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/workspace.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full root suite (coverage gate)**

Run: `npm test`
Expected: PASS at 100% on `src/**` — ensure both the default-port branch and explicit-port branch of `runBoard` are covered (the two tests above do this).

- [ ] **Step 6: Commit**

```bash
rtk git add src/workspace.js test/workspace.test.js
rtk git commit -m "feat: ai-workspace board subcommand spawns the server"
```

---

## Task 8: End-to-end smoke + docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Manual smoke test**

```bash
# Seed a board
node bin/workspace.js status demo inprogress --board /tmp/board.json
# Build the front-end
cd apps/board && pnpm install && pnpm build && cd -
# Launch and open
node bin/workspace.js board --board /tmp/board.json --port 4173
```

Open `http://localhost:4173` — expect a four-column board with `demo` under "In progress". Run `node bin/workspace.js status demo question --board /tmp/board.json` and within ~3s the card moves to the amber "Question" column.

- [ ] **Step 2: Document in `README.md`**

Add a "Board app" section: how to build (`pnpm --dir apps/board build`), how to launch (`ai-workspace board --board <path>`), the polling interval, and that the board is read-only.

- [ ] **Step 3: Commit**

```bash
rtk git add README.md
rtk git commit -m "docs: document the board app"
```

---

## Self-Review

- **Spec coverage:** Section 3 server → Tasks 2–3; Section 3 Vue front-end (four columns, question emphasized via amber accent, polling) → Tasks 4–6; `ai-workspace board` launcher → Task 7; Section 4 server test (`/api/board` present + missing) → Task 2; Section 4 front-end light tests → Tasks 4 and 6.
- **Type consistency:** server `createBoardServer({ boardPath, distDir })` and `startFromArgv(argv)`; front-end `useBoard({ intervalMs, fetchImpl })` returning `{ repos, error, refresh, stop }`; `repos.value` shape matches `board.json.repos`. `runBoard` spawns `node apps/board/server.js --board <path> --port <n>`, matching `startFromArgv`'s accepted options.
- **Placeholder scan:** none — all components and tests are complete.
- **Coverage boundary:** server/front-end live under `apps/board/**`, outside the `src/**` coverage gate; only `runBoard` in `src/workspace.js` is gated and is covered by Task 7's two tests.
