# Board Drag-to-Done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drag a session's card onto the board's "Done" column to manually close that session — removing it from `board.json` and appending a final record to `history.jsonl` — as a fallback for when the `SessionEnd` hook never fires (crash / hard kill).

**Architecture:** A new `closeSession` helper in `libs/workspace-bootstrap` does the actual close (append history, remove from board — same effect as the hook-driven path, but without a transcript). A new `POST /api/sessions/close` endpoint on the board server exposes it. On the frontend, `SessionRow` becomes an HTML5 drag source carrying `{repo, sessionId}`; only the `Done` `Column` is a drop target; `App.vue` confirms via `window.confirm()`, calls the endpoint, then refreshes the board.

**Tech Stack:** Node.js (`node:test`, `node:http`), Vue 3 `<script setup>`, Vitest + `@vue/test-utils`, native HTML5 drag-and-drop (no new dependency).

**Spec:** `docs/superpowers/specs/2026-08-08-board-drag-to-done-design.md`

---

## Task 1: `closeSession` helper (`libs/workspace-bootstrap`)

**Files:**

- Modify: `libs/workspace-bootstrap/src/board.js`
- Modify: `libs/workspace-bootstrap/src/index.js`
- Test: `libs/workspace-bootstrap/test/board.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `libs/workspace-bootstrap/test/board.test.js` (after the existing `initRepos` tests, i.e. at the end of the file):

```js
test('closeSession appends a history entry and removes the session, leaving a sibling session untouched', async () => {
  const appends = [];
  const writes = [];
  const result = await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: {
        s1: {
          status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'fix bug', lastPrompt: 'fix bug',
          startedAt: 'T0', usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }, events: [],
        },
        s2: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'b', lastPrompt: 'b', startedAt: 'T0', usage: null, events: [] },
      } } },
    }),
    write: async (file, data) => writes.push([file, data]),
    move: async () => {},
    ensureDir: async () => {},
    append: async (file, data) => appends.push([file, data]),
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(result, { closed: true });
  assert.equal(appends.length, 1);
  assert.equal(appends[0][0], '/x/history.jsonl');
  assert.deepEqual(JSON.parse(appends[0][1]), {
    repo: 'a', sessionId: 's1', title: 'fix bug', startedAt: 'T0', endedAt: 'T2',
    usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
  });
  const written = JSON.parse(writes[0][1]);
  assert.deepEqual(Object.keys(written.repos.a.sessions), ['s2']);
});

test('closeSession records null usage when the session has none yet', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: null, lastPrompt: null, startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0].usage, null);
  assert.equal(appends[0].title, null);
});

test('closeSession is a no-op and returns closed:false when the repo is not on the board', async () => {
  const result = await closeSession('/x/board.json', 'unknown', 's1', {
    historyPath: '/x/history.jsonl',
    read: async () => '{"version":2,"repos":{}}',
    write: async () => { throw new Error('must not write'); },
    append: async () => { throw new Error('must not append'); },
  });
  assert.deepEqual(result, { closed: false });
});

test('closeSession is a no-op and returns closed:false when the session is not on the repo', async () => {
  const result = await closeSession('/x/board.json', 'a', 'unknown-session', {
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => { throw new Error('must not write'); },
    append: async () => { throw new Error('must not append'); },
  });
  assert.deepEqual(result, { closed: false });
});

test('closeSession defaults historyPath to the sibling history.jsonl when not passed', async () => {
  const appends = [];
  await closeSession('/d/board.json', 'a', 's1', {
    now: () => 'T2',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p', startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file) => appends.push(file),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0], path.join('/d', 'history.jsonl'));
});

test('closeSession stamps endedAt with the current ISO time by default', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p', startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.match(appends[0].endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
```

Update the import line at the top of the same file to pull in `closeSession`:

```js
import { STATES, resolveBoardPath, readBoard, writeBoard, setSessionStatus, removeSession, closeSession, initRepos } from '../src/board.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test libs/workspace-bootstrap/test/board.test.js`
Expected: FAIL — `closeSession is not a function` (or similar import error) for each new test.

- [ ] **Step 3: Implement `closeSession`**

In `libs/workspace-bootstrap/src/board.js`, add the import at the top (line 1-2 currently reads `import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';` / `import path from 'node:path';`):

```js
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveHistoryPath, appendHistoryEntry } from './tokens.js';
```

Then add the function after `removeSession` (which currently ends the file just before `initRepos`):

```js
export async function closeSession(boardPath, repo, sessionId, opts = {}) {
  const {
    historyPath = resolveHistoryPath(boardPath),
    now = () => new Date().toISOString(),
    ...io
  } = opts;
  const board = await readBoard(boardPath, io);
  const session = board.repos[repo]?.sessions?.[sessionId];
  if (!session) return { closed: false };
  await appendHistoryEntry(historyPath, {
    repo, sessionId,
    title: session.title ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: now(),
    usage: session.usage ?? null,
  }, io);
  delete board.repos[repo].sessions[sessionId];
  await writeBoard(boardPath, board, io);
  return { closed: true };
}
```

- [ ] **Step 4: Export it from the package entry**

In `libs/workspace-bootstrap/src/index.js`, change:

```js
export { resolveBoardPath, readBoard, setSessionStatus, removeSession } from './board.js';
```

to:

```js
export { resolveBoardPath, readBoard, setSessionStatus, removeSession, closeSession } from './board.js';
```

- [ ] **Step 5: Run tests to verify they pass, with full coverage**

Run: `node --test --experimental-test-coverage --test-coverage-include="libs/workspace-bootstrap/src/**/*.js" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 "libs/workspace-bootstrap/test/**/*.test.js"`
Expected: PASS, 100% lines/functions/branches (this is the same command the `workspace-bootstrap:test` Nx target runs — the whole suite must stay green, not just the new tests).

- [ ] **Step 6: Commit**

```bash
git add libs/workspace-bootstrap/src/board.js libs/workspace-bootstrap/src/index.js libs/workspace-bootstrap/test/board.test.js
git commit -m "feat(workspace): add closeSession to manually close a board session"
```

---

## Task 2: `POST /api/sessions/close` endpoint (`apps/board/server.js`)

**Files:**

- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `apps/board/server.test.js` (after the existing `GET /api/config returns empty repos...` test, before the `resolveServerBoardPath` tests):

```js
test('POST /api/sessions/close closes an existing session: removes it from the board and appends history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  await writeFile(boardPath, JSON.stringify({
    version: 2,
    repos: { a: { sessions: {
      s1: {
        status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'fix bug', lastPrompt: 'fix bug',
        startedAt: 'T0', usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }, events: [],
      },
      s2: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'b', lastPrompt: 'b', startedAt: 'T0', usage: null, events: [] },
    } } },
  }));
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 's1' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { closed: true });
  const board = JSON.parse(await readFile(boardPath, 'utf8'));
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s2']);
  const historyLines = (await readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(historyLines.length, 1);
  const historyEntry = JSON.parse(historyLines[0]);
  assert.equal(historyEntry.repo, 'a');
  assert.equal(historyEntry.sessionId, 's1');
  assert.deepEqual(historyEntry.usage, { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 404 for an unknown session and leaves the board untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const original = JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'question' } } } } });
  await writeFile(boardPath, original);
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 'unknown' }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { closed: false });
  assert.equal(await readFile(boardPath, 'utf8'), original);
  await assert.rejects(() => readFile(path.join(dir, 'history.jsonl')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 400 when repo or sessionId is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a' }),
  });
  assert.equal(res.status, 400);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 400 for an unparsable body', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/board/server.test.js`
Expected: FAIL — requests to `/api/sessions/close` fall through to the static-file/SPA-fallback handler today, so the assertions on `res.status` (200/404/400) fail.

- [ ] **Step 3: Implement the endpoint**

In `apps/board/server.js`, change the import line (currently line 8):

```js
import { reconcileHooks, resolveHistoryPath } from '@linktogo/ai-workspace-bootstrap';
```

to:

```js
import { reconcileHooks, resolveHistoryPath, closeSession } from '@linktogo/ai-workspace-bootstrap';
```

Add two new functions after `serveConfig` and before `serveStatic`:

```js
async function readJSONBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveCloseSession(boardPath, req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const { repo, sessionId } = body ?? {};
  if (!repo || !sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'repo and sessionId are required' }));
    return;
  }
  const result = await closeSession(boardPath, repo, sessionId);
  res.writeHead(result.closed ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
```

Then in `createBoardServer`, add a route check before the `serveStatic` fallback:

```js
export function createBoardServer({ boardPath, distDir, config = null }) {
  const historyPath = resolveHistoryPath(boardPath);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      if (url.pathname === '/api/history') return await serveHistory(historyPath, res);
      if (url.pathname === '/api/config') return serveConfig(config, res);
      if (url.pathname === '/api/sessions/close' && req.method === 'POST') return await serveCloseSession(boardPath, req, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/board/server.test.js`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/board/server.js apps/board/server.test.js
git commit -m "feat(board): add POST /api/sessions/close endpoint"
```

---

## Task 3: `SessionRow.vue` becomes a drag source

**Files:**

- Modify: `apps/board/src/SessionRow.vue`
- Modify: `apps/board/src/Card.vue`
- Test: `apps/board/src/SessionRow.test.js`
- Test: `apps/board/src/Card.test.js`

- [ ] **Step 1: Write the failing tests**

In `apps/board/src/SessionRow.test.js`, change the import line at the top from:

```js
import { test, expect } from 'vitest';
```

to:

```js
import { test, expect, vi } from 'vitest';
```

Then append this test at the end of the file:

```js
test('dragstart sets the drag payload to the repo name and session id', async () => {
  const w = mount(SessionRow, { props: { session: session(), repoName: 'oc-be', now } });
  const setData = vi.fn();
  await w.get('[data-test=session-row]').trigger('dragstart', { dataTransfer: { setData, effectAllowed: null } });
  expect(setData).toHaveBeenCalledWith('application/json', JSON.stringify({ repo: 'oc-be', sessionId: 's1' }));
});
```

In `apps/board/src/Card.test.js`, add this import and test:

```js
import SessionRow from './SessionRow.vue';
```

```js
test('passes its repo name down to each session row', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now } });
  expect(w.findComponent(SessionRow).props('repoName')).toBe('oc-be');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/board/`): `npx vitest run src/SessionRow.test.js src/Card.test.js`
Expected: FAIL — `SessionRow` has no `repoName` prop yet and never calls `dataTransfer.setData`; `Card` doesn't pass a `repo-name` binding.

- [ ] **Step 3: Implement the drag source**

In `apps/board/src/SessionRow.vue`, change the `defineProps` block (lines 8-11) to add `repoName`:

```js
const props = defineProps({
  session: { type: Object, required: true },
  repoName: { type: String, default: '' },
  now: { type: Number, default: () => Date.now() },
});
```

Add a handler near `open`/`toggle` (after line 35, `function toggle(e) { ... }`):

```js
function onDragStart(e) {
  e.dataTransfer.setData('application/json', JSON.stringify({ repo: props.repoName, sessionId: props.session.sessionId }));
  e.dataTransfer.effectAllowed = 'move';
}
```

Update the root `<div>` in the template (currently starting at line 39) to add `draggable` and `@dragstart`:

```html
<div
  role="button"
  tabindex="0"
  data-test="session-row"
  draggable="true"
  class="py-1.5 cursor-pointer"
  @click="open"
  @keydown.enter="open"
  @keydown.space.prevent="open"
  @dragstart="onDragStart"
>
```

In `apps/board/src/Card.vue`, update the `SessionRow` usage (line 28) to pass the repo name:

```html
<SessionRow v-for="s in sessions" :key="s.sessionId" :session="s" :repo-name="name" :now="now" @open="open" />
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `apps/board/`): `npx vitest run src/SessionRow.test.js src/Card.test.js`
Expected: PASS (all tests, including pre-existing ones in both files).

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/SessionRow.vue apps/board/src/Card.vue apps/board/src/SessionRow.test.js apps/board/src/Card.test.js
git commit -m "feat(board): make session rows draggable, carrying repo+session id"
```

---

## Task 4: `Column.vue` becomes a Done drop target

**Files:**

- Modify: `apps/board/src/Column.vue`
- Test: `apps/board/src/Column.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/board/src/Column.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Column from './Column.vue';

function mountColumn(status) {
  return mount(Column, { props: { title: 'Done', status, entries: [], now: 0 } });
}

test('drop on the done column emits close-session with the dropped payload', async () => {
  const w = mountColumn('done');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'oc-be', sessionId: 's1' }) };
  await w.get('[data-test=column-body]').trigger('drop', { dataTransfer });
  expect(w.emitted('close-session')[0]).toEqual([{ repo: 'oc-be', sessionId: 's1' }]);
});

test('dragover on the done column highlights the drop zone, dragleave clears it', async () => {
  const w = mountColumn('done');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).toContain('ring-2');
  await body.trigger('dragleave');
  expect(body.classes()).not.toContain('ring-2');
});

test('dropping clears the drop-zone highlight', async () => {
  const w = mountColumn('done');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).toContain('ring-2');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'a', sessionId: 's1' }) };
  await body.trigger('drop', { dataTransfer });
  expect(body.classes()).not.toContain('ring-2');
});

test('a non-done column has no drag listeners: dragover does not highlight, drop emits nothing', async () => {
  const w = mountColumn('todo');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).not.toContain('ring-2');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'a', sessionId: 's1' }) };
  await body.trigger('drop', { dataTransfer });
  expect(w.emitted('close-session')).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/board/`): `npx vitest run src/Column.test.js`
Expected: FAIL — `Column.vue` has no `data-test="column-body"` element, no drag handlers, and never emits `close-session`.

- [ ] **Step 3: Implement the drop target**

Replace the full contents of `apps/board/src/Column.vue` with:

```vue
<script setup>
import { ref, computed } from 'vue';
import Card from './Card.vue';

const props = defineProps({
  title: { type: String, required: true },
  status: { type: String, required: true },
  accent: { type: String, default: 'bg-slate-100' },
  entries: { type: Array, required: true }, // [{ name, sessions }]
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open', 'close-session']);

const isDropTarget = computed(() => props.status === 'done');
const dragOver = ref(false);

function onDragOver(e) {
  e.preventDefault();
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}
function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  const { repo, sessionId } = JSON.parse(e.dataTransfer.getData('application/json'));
  emit('close-session', { repo, sessionId });
}
</script>

<template>
  <section class="min-w-0">
    <h2 :class="['rounded-t-md px-3 py-2 text-sm font-semibold text-slate-700', accent]">
      {{ title }} <span class="text-slate-400">({{ entries.length }})</span>
    </h2>
    <div
      data-test="column-body"
      :class="['flex flex-col gap-2 bg-slate-50 p-2 rounded-b-md min-h-[4rem]',
               dragOver ? 'ring-2 ring-emerald-400' : '']"
      v-on="isDropTarget ? { dragover: onDragOver, dragleave: onDragLeave, drop: onDrop } : {}"
    >
      <Card v-for="e in entries" :key="e.name" :name="e.name" :sessions="e.sessions" :status="status" :now="now" @open="$emit('open', $event)" />
    </div>
  </section>
</template>
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `apps/board/`): `npx vitest run src/Column.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/Column.vue apps/board/src/Column.test.js
git commit -m "feat(board): turn the Done column into a session drop target"
```

---

## Task 5: `App.vue` wires confirm + close + refresh

**Files:**

- Modify: `apps/board/src/App.vue`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Write the failing tests**

In `apps/board/src/App.test.js`, update the imports at the top:

```js
import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import App from './App.vue';
import Column from './Column.vue';
```

Add a cleanup hook right after the imports (before `function routedFetch() {`):

```js
afterEach(() => { vi.restoreAllMocks(); });
```

Append these two tests at the end of the file:

```js
test('dropping a session on Done confirms, closes it via the API, and refreshes the board', async () => {
  const calls = [];
  const fetchImpl = vi.fn().mockImplementation((url, init) => {
    calls.push(url);
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/sessions/close') return Promise.resolve({ json: async () => ({ closed: true }) });
    return Promise.resolve({ json: async () => ({
      version: 2,
      repos: { b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } } },
    }) });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
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
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
  const doneColumn = wrapper.findAllComponents(Column)[3];
  await doneColumn.vm.$emit('close-session', { repo: 'b', sessionId: 's1' });
  await settle();
  expect(fetchImpl.mock.calls.some(([u]) => u === '/api/sessions/close')).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/board/`): `npx vitest run src/App.test.js`
Expected: FAIL — `App.vue` doesn't listen for `close-session` yet, so `window.confirm` is never called and no request to `/api/sessions/close` is made.

- [ ] **Step 3: Implement the wiring**

In `apps/board/src/App.vue`, change the `useBoard` destructuring (line 20):

```js
const { repos, transitions, connected, refresh } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
```

Add a handler after `entriesFor`/`grouped` (near the other computed/functions, e.g. right after the `grouped` computed on line 82):

```js
async function onCloseSession({ repo, sessionId }) {
  const label = repos.value[repo]?.sessions?.[sessionId]?.title ?? sessionId;
  if (!window.confirm(`Marquer la session « ${label} » de ${repo} comme terminée ?`)) return;
  await fetchImpl('/api/sessions/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, sessionId }),
  });
  await refresh();
}
```

Update the `Column` usage in the template (lines 134-138) to listen for the new event:

```html
<Column
  v-for="c in grouped" :key="c.status"
  :title="c.title" :status="c.status" :accent="c.accent" :entries="c.entries" :now="now"
  @open="selected = $event"
  @close-session="onCloseSession"
/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `apps/board/`): `npx vitest run src/App.test.js`
Expected: PASS (all tests, including pre-existing ones).

- [ ] **Step 5: Run the full board test suite**

Run: `npm run test:board`
Expected: PASS — server tests (`node:test`) and every Vitest file in `apps/board/src`.

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/App.test.js
git commit -m "feat(board): confirm and close a session when dropped on Done"
```

---

## Task 6: Changelog entry

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add a bullet after the token-usage/history entry (after the line ending `...browsable in a new "Historique" tab (`GET /api/history`).`):

```markdown
- A session card can now be dragged onto the "Done" column to close it by
  hand (`POST /api/sessions/close`) — the same effect as a normal
  `SessionEnd`, for when that hook doesn't fire (crash / hard kill).
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for board drag-to-done"
```

---

## Final verification

- [ ] Run the whole repo suite end to end: `npm run lint && npm test && npm run build`
- [ ] Manually verify in a browser: `npm start` (or `npm run board:build && node apps/board/server.js` against a `board.json` with at least one session in `todo`/`inprogress`/`question`), drag a session card onto "Done", confirm the dialog, and check the card disappears and a new line appears in `history.jsonl` next to the board file.
