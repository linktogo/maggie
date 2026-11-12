# Board Multi-Session Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board session-aware so that two Claude Code sessions running against the same repo checkout each get their own card, showing that session's stable title (first prompt) and its latest prompt (140 chars, expandable), instead of silently overwriting each other into one card.

**Architecture:** `board.json` moves from `repos[name] = { status, ... }` to `repos[name] = { sessions: { [session_id]: { status, title, lastPrompt, ... } } }`. Claude Code already puts `session_id`/`prompt`/`hook_event_name` on every hook's JSON stdin payload, so the `ai-workspace` CLI reads it and threads a `sessionId` through a new `setSessionStatus()`/`removeSession()` pair in `libs/workspace-bootstrap`. A new `SessionEnd` hook removes a session's entry when its process exits. The board server keeps passing the file through unchanged; the Vue front-end groups by repo but shows a repo's card in every column that has one of its sessions, each column's copy listing only that column's sessions.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`) for `libs/workspace-bootstrap` and `apps/workspace`; Vue 3 + Vitest + `@vue/test-utils` for `apps/board`. No new runtime dependencies.

**Reference:** Full rationale and decisions in `docs/superpowers/specs/2026-08-05-board-multi-session-cards-design.md`.

---

## Lot 1 — Data model, hooks & CLI

### Task 1: Session-aware board state (`board.js`)

**Files:**
- Modify: `libs/workspace-bootstrap/src/board.js`
- Modify: `libs/workspace-bootstrap/src/index.js`
- Modify: `libs/workspace-bootstrap/README.md`
- Test: `libs/workspace-bootstrap/test/board.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `libs/workspace-bootstrap/test/board.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STATES, resolveBoardPath, readBoard, writeBoard, setSessionStatus, removeSession, initRepos } from '../src/board.js';

test('STATES are the four kanban columns in order', () => {
  assert.deepEqual(STATES, ['todo', 'inprogress', 'question', 'done']);
});
test('resolveBoardPath prefers the explicit board option', () => {
  assert.equal(resolveBoardPath({ board: 'b.json', env: {} }), path.resolve('b.json'));
});
test('resolveBoardPath falls back to AI_SYNC_BOARD', () => {
  assert.equal(resolveBoardPath({ env: { AI_SYNC_BOARD: '/tmp/x/board.json' } }), '/tmp/x/board.json');
});
test('resolveBoardPath throws when neither is set', () => {
  assert.throws(() => resolveBoardPath({ env: {} }), /No board path/);
});

test('readBoard parses an existing v2 board and leaves sessions untouched', async () => {
  const sessions = { s1: { status: 'done', updatedAt: 'T', lastEvent: 'x', title: null, lastPrompt: null, events: [] } };
  const read = async () => JSON.stringify({ version: 2, repos: { a: { sessions } } });
  assert.deepEqual(await readBoard('/x', { read }), { version: 2, repos: { a: { sessions } } });
});

test('readBoard normalizes a v1 flat repo entry into the empty v2 sessions shape', async () => {
  const read = async () => JSON.stringify({ version: 1, repos: { a: { status: 'done', updatedAt: 'T', lastEvent: 'x', events: [] } } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board, { version: 2, repos: { a: { sessions: {} } } });
});

test('readBoard normalizes a repo entry with no sessions key to empty sessions', async () => {
  const read = async () => JSON.stringify({ repos: { a: {} } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board.repos.a, { sessions: {} });
});

test('readBoard returns an empty v2 board when the file is missing', async () => {
  const read = async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  assert.deepEqual(await readBoard('/x', { read }), { version: 2, repos: {} });
});
test('readBoard rethrows non-ENOENT errors', async () => {
  const read = async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; };
  await assert.rejects(() => readBoard('/x', { read }), /boom/);
});

test('writeBoard ensures the dir, writes a temp file, then renames (atomic)', async () => {
  const calls = [];
  await writeBoard('/d/board.json', { version: 2, repos: {} }, {
    ensureDir: async (dir, opts) => calls.push(['ensureDir', dir, opts]),
    write: async (file, data) => calls.push(['write', file, data]),
    move: async (from, to) => calls.push(['move', from, to]),
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(calls, [
    ['ensureDir', '/d', { recursive: true }],
    ['write', '/d/board.json.tmp', '{\n  "version": 2,\n  "repos": {}\n}\n'],
    ['move', '/d/board.json.tmp', '/d/board.json'],
  ]);
});

test('setSessionStatus creates a new session on a repo not yet on the board, storing the given title/lastPrompt', async () => {
  const board = await setSessionStatus('/x', 'oc-be', 'sess-1', 'question', {
    lastEvent: 'Notification', title: 'first prompt', lastPrompt: 'first prompt',
    now: () => '2026-06-16T10:00:00Z',
    read: async () => JSON.stringify({ version: 2, repos: {} }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos['oc-be'].sessions['sess-1'], {
    status: 'question',
    updatedAt: '2026-06-16T10:00:00Z',
    lastEvent: 'Notification',
    title: 'first prompt',
    lastPrompt: 'first prompt',
    events: [{ event: 'Notification', at: '2026-06-16T10:00:00Z' }],
  });
});

test('setSessionStatus updates an existing session without touching a sibling session', async () => {
  const board = await setSessionStatus('/x', 'oc-be', 'sess-1', 'inprogress', {
    lastEvent: 'UserPromptSubmit',
    now: () => 'T2',
    read: async () => JSON.stringify({
      version: 2,
      repos: { 'oc-be': { sessions: {
        'sess-1': { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'a', lastPrompt: 'a', events: [] },
        'sess-2': { status: 'done', updatedAt: 'T1', lastEvent: 'Stop', title: 'b', lastPrompt: 'b', events: [] },
      } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos['oc-be'].sessions['sess-1'].status, 'inprogress');
  assert.deepEqual(board.repos['oc-be'].sessions['sess-2'], { status: 'done', updatedAt: 'T1', lastEvent: 'Stop', title: 'b', lastPrompt: 'b', events: [] });
});

test('setSessionStatus sets title only on the first write and preserves it afterwards', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'first prompt', lastPrompt: 'first prompt', events: [] } } } },
  });
  const board = await setSessionStatus('/x', 'a', 's1', 'question', {
    title: 'a different title', now: () => 'T2', read,
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.title, 'first prompt');
});

test('setSessionStatus overwrites lastPrompt when passed and preserves the previous value when omitted', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 't', lastPrompt: 'old prompt', events: [] } } } },
  });
  const io = { now: () => 'T2', write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp' };

  const withNewPrompt = await setSessionStatus('/x', 'a', 's1', 'inprogress', { ...io, read, lastPrompt: 'new prompt' });
  assert.equal(withNewPrompt.repos.a.sessions.s1.lastPrompt, 'new prompt');

  const withoutPrompt = await setSessionStatus('/x', 'a', 's1', 'question', { ...io, read });
  assert.equal(withoutPrompt.repos.a.sessions.s1.lastPrompt, 'old prompt');
});

test('setSessionStatus prepends events newest-first and caps history at MAX_EVENTS per session', async () => {
  const prior = Array.from({ length: 20 }, (_, i) => ({ event: `e${i}`, at: 'old' }));
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    lastEvent: 'pushed', now: () => 'NOW',
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'inprogress', events: prior } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  const events = board.repos.a.sessions.s1.events;
  assert.equal(events.length, 20);
  assert.deepEqual(events[0], { event: 'pushed', at: 'NOW' });
  assert.equal(events[19].event, 'e18'); // oldest entry dropped
});
test('setSessionStatus defaults lastEvent to manual', async () => {
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    now: () => 'T', read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.lastEvent, 'manual');
});
test('setSessionStatus rejects an invalid state', async () => {
  await assert.rejects(() => setSessionStatus('/x', 'a', 's1', 'bogus', {}), /Invalid state "bogus"/);
});
test('setSessionStatus stamps an ISO timestamp by default', async () => {
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.match(board.repos.a.sessions.s1.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('removeSession deletes one session and leaves a sibling session and other repos intact', async () => {
  const board = await removeSession('/x', 'a', 's1', {
    read: async () => JSON.stringify({
      version: 2,
      repos: {
        a: { sessions: { s1: { status: 'done' }, s2: { status: 'inprogress' } } },
        b: { sessions: { s3: { status: 'todo' } } },
      },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s2']);
  assert.deepEqual(Object.keys(board.repos.b.sessions), ['s3']);
});
test('removeSession is a no-op when the repo is not on the board', async () => {
  const board = await removeSession('/x', 'unknown', 's1', {
    read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos, {});
});
test('removeSession is a no-op when the session is not on the repo', async () => {
  const board = await removeSession('/x', 'a', 'unknown-session', {
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s1']);
});

test('initRepos adds missing repos with empty sessions without clobbering existing ones', async () => {
  const board = await initRepos('/x', ['a', 'b'], {
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos.a, { sessions: { s1: { status: 'done' } } });
  assert.deepEqual(board.repos.b, { sessions: {} });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace-bootstrap`
Expected: FAIL — `setSessionStatus`/`removeSession` are not exported yet, and the existing `setStatus`-based tests are gone so there's nothing to pass against the new shape.

- [ ] **Step 3: Implement the new `board.js`**

Replace `libs/workspace-bootstrap/src/board.js`:

```js
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const STATES = ['todo', 'inprogress', 'question', 'done'];

export const MAX_EVENTS = 20;

export function resolveBoardPath({ board, env = process.env } = {}) {
  const p = board || env.AI_SYNC_BOARD;
  if (!p) throw new Error('No board path (pass --board <path> or set AI_SYNC_BOARD)');
  return path.resolve(p);
}

// board.json is disposable runtime state, regenerated continuously by hooks.
// Anything not already in the v2 `{ sessions: {...} }` shape (a v1 flat
// entry, or malformed data) is reset rather than migrated — hooks repopulate
// it within moments.
function normalizeRepoEntry(entry) {
  return entry?.sessions && typeof entry.sessions === 'object' ? entry : { sessions: {} };
}

export async function readBoard(boardPath, { read = readFile } = {}) {
  try {
    const parsed = JSON.parse(await read(boardPath, 'utf8'));
    const board = { ...parsed, version: 2, repos: { ...parsed.repos } };
    for (const [name, entry] of Object.entries(board.repos)) {
      board.repos[name] = normalizeRepoEntry(entry);
    }
    return board;
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 2, repos: {} };
    throw err;
  }
}

export async function writeBoard(boardPath, board, opts = {}) {
  const {
    write = writeFile,
    move = rename,
    ensureDir = mkdir,
    tmpSuffix = `.${process.pid}.tmp`,
  } = opts;
  await ensureDir(path.dirname(boardPath), { recursive: true });
  const tmp = `${boardPath}${tmpSuffix}`;
  await write(tmp, JSON.stringify(board, null, 2) + '\n');
  await move(tmp, boardPath);
}

export async function setSessionStatus(boardPath, repo, sessionId, state, opts = {}) {
  const { lastEvent = 'manual', title, lastPrompt, now = () => new Date().toISOString(), ...io } = opts;
  if (!STATES.includes(state)) {
    throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  }
  const board = await readBoard(boardPath, io);
  const at = now();
  const repoEntry = board.repos[repo] ?? { sessions: {} };
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
  board.repos[repo] = repoEntry;
  await writeBoard(boardPath, board, io);
  return board;
}

export async function removeSession(boardPath, repo, sessionId, opts = {}) {
  const board = await readBoard(boardPath, opts);
  if (board.repos[repo]) {
    delete board.repos[repo].sessions[sessionId];
  }
  await writeBoard(boardPath, board, opts);
  return board;
}

export async function initRepos(boardPath, repoNames, opts = {}) {
  const board = await readBoard(boardPath, opts);
  for (const name of repoNames) {
    if (!board.repos[name]) board.repos[name] = { sessions: {} };
  }
  await writeBoard(boardPath, board, opts);
  return board;
}
```

- [ ] **Step 4: Update the package's exports and README**

In `libs/workspace-bootstrap/src/index.js`, replace the board export line:

```js
export { resolveBoardPath, setSessionStatus, removeSession } from './board.js';
```

In `libs/workspace-bootstrap/README.md`, replace the usage example:

```js
import { setSessionStatus } from '@linktogo/ai-workspace-bootstrap';

await setSessionStatus('/ws/.ai-sync/board.json', 'example-api', 'sess-1', 'done');
```

Board states are `todo`, `inprogress`, `question`, and `done`. Each repo tracks
one entry per Claude Code session (keyed by `session_id`); writes are atomic
and keep a bounded per-session event history.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, 100% coverage (lines/functions/branches) on `libs/workspace-bootstrap/src/board.js`.

- [ ] **Step 6: Commit**

```bash
git add libs/workspace-bootstrap/src/board.js libs/workspace-bootstrap/src/index.js libs/workspace-bootstrap/README.md libs/workspace-bootstrap/test/board.test.js
git commit -m "feat(workspace): track board sessions per Claude Code session_id"
```

---

### Task 2: `SessionEnd` hook wiring (`hooks.js`)

**Files:**
- Modify: `libs/workspace-bootstrap/src/hooks.js`
- Test: `libs/workspace-bootstrap/test/hooks.test.js`
- Test: `libs/workspace-bootstrap/test/reconcile.test.js` (fixture update only — `reconcile.js` itself needs no change, since it already iterates `HOOK_EVENTS` generically)

- [ ] **Step 1: Write the failing tests**

Replace `libs/workspace-bootstrap/test/hooks.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookSettings, installHooks } from '../src/hooks.js';
import path from 'node:path';

test('hookSettings maps the four events to their commands', () => {
  const s = hookSettings('oc-be', '/ws/.ai-sync/board.json', { command: 'node /a/bin/workspace.js' });
  const cmd = (e) => s.hooks[e][0].hooks[0].command;
  assert.equal(s.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(cmd('UserPromptSubmit'),
    'node /a/bin/workspace.js status oc-be inprogress --board /ws/.ai-sync/board.json --event UserPromptSubmit');
  assert.equal(s.hooks.Notification[0].matcher, 'permission_prompt|idle_prompt');
  assert.equal(cmd('Notification'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.ai-sync/board.json --event Notification');
  assert.equal(cmd('Stop'),
    'node /a/bin/workspace.js status oc-be question --board /ws/.ai-sync/board.json --event Stop');
  assert.equal(s.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(s.hooks.SessionEnd[0].matcher, undefined);
  assert.equal(cmd('SessionEnd'), 'node /a/bin/workspace.js session-end oc-be --board /ws/.ai-sync/board.json');
});

test('hookSettings defaults the command to ai-workspace', () => {
  const s = hookSettings('a', '/b.json');
  assert.match(s.hooks.Stop[0].hooks[0].command, /^ai-workspace status a question /);
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /^ai-workspace session-end a /);
});

test('installHooks writes a fresh settings.local.json when none exists', async () => {
  const writes = [];
  const res = await installHooks('/ws/oc-be', 'oc-be', '/b.json', {
    command: 'ai-workspace',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (file, data) => writes.push({ file, data }),
    ensureDir: async () => {},
  });
  assert.equal(res.file, path.join('/ws/oc-be', '.claude', 'settings.local.json'));
  assert.equal(writes.length, 1);
  assert.ok(JSON.parse(writes[0].data).hooks.Stop);
  assert.ok(JSON.parse(writes[0].data).hooks.SessionEnd);
});

test('installHooks merges hooks while preserving existing unrelated settings', async () => {
  let written;
  await installHooks('/ws/a', 'a', '/b.json', {
    read: async () => JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: ['keep'] } }),
    write: async (_f, data) => { written = JSON.parse(data); },
    ensureDir: async () => {},
  });
  assert.deepEqual(written.permissions, { allow: ['Bash'] });
  assert.deepEqual(written.hooks.PreToolUse, ['keep']);
  assert.ok(written.hooks.UserPromptSubmit);
});

test('installHooks rethrows non-ENOENT read errors', async () => {
  await assert.rejects(() => installHooks('/ws/a', 'a', '/b.json', {
    read: async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; },
    write: async () => {}, ensureDir: async () => {},
  }), /boom/);
});
```

In `libs/workspace-bootstrap/test/reconcile.test.js`, update `expectedHooks()` to include the new hook:

```js
function expectedHooks(repo) {
  return {
    UserPromptSubmit: `${hookCommand} status ${repo} inprogress --board ${boardPath} --event UserPromptSubmit`,
    Notification: `${hookCommand} status ${repo} question --board ${boardPath} --event Notification`,
    Stop: `${hookCommand} status ${repo} question --board ${boardPath} --event Stop`,
    SessionEnd: `${hookCommand} session-end ${repo} --board ${boardPath}`,
  };
}
```

**Second, unrelated fix bundled into this same file (discovered during Task 1's code review, not part of the original design doc):** Task 1 changed `initRepos()` to seed idle repos as `{ sessions: {} }` instead of a flat `{status: 'todo', ...}` object. `reconcile.test.js`'s `'default initBoard seeds the board for real when not overridden'` test still asserted the old shape and was left broken by Task 1 (Task 1's own file list didn't include this test). Fix its final assertion:

```js
  assert.deepEqual(board.repos.a, { sessions: {} });
```

replacing the old `assert.equal(board.repos.a.status, 'todo');` — everything else in that test (setup, the `reconcileHooks` call, cleanup) is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace-bootstrap`
Expected: FAIL — `hooks.test.js` has no `SessionEnd` entry yet; `reconcile.test.js`'s "up-to-date" test now fails too, since the real `hookSettings()` produces a 4th `SessionEnd` command that the hand-built `expectedHooks()` fixture didn't have before this edit — after the edit it should already match, so this failure should disappear once Step 3 lands `hooks.js`. Confirm the two hooks.test.js `SessionEnd` assertions fail with something like `hooks.SessionEnd is undefined`.

- [ ] **Step 3: Implement the `SessionEnd` hook in `hooks.js`**

Replace `libs/workspace-bootstrap/src/hooks.js`:

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Each Claude Code lifecycle event maps to an action this hook performs: a
// fresh prompt or an idle/permission wait updates the board status; a
// SessionEnd means the process behind this session is going away, so its
// entry is removed instead of transitioning a status.
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

export async function installHooks(checkoutDir, repo, boardPath, opts = {}) {
  const { read = readFile, write = writeFile, ensureDir = mkdir, command } = opts;
  const dir = path.join(checkoutDir, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let existing = {};
  try {
    existing = JSON.parse(await read(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const { hooks } = hookSettings(repo, boardPath, { command });
  const merged = { ...existing, hooks: { ...existing.hooks, ...hooks } };
  await ensureDir(dir, { recursive: true });
  await write(file, JSON.stringify(merged, null, 2) + '\n');
  return { file, merged };
}
```

`reconcile.js` needs no code change: it already builds its expected/actual hook maps by iterating the `HOOK_EVENTS` list exported from `hooks.js`, so `SessionEnd` is picked up automatically by the existing drift-detection logic.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, 100% coverage, including `reconcile.test.js` (confirms a checkout still missing the `SessionEnd` hook gets flagged `repointed` by the pre-existing generic drift check).

- [ ] **Step 5: Commit**

```bash
git add libs/workspace-bootstrap/src/hooks.js libs/workspace-bootstrap/test/hooks.test.js libs/workspace-bootstrap/test/reconcile.test.js
git commit -m "feat(workspace): remove a session's board entry via a SessionEnd hook"
```

---

### Task 3: CLI stdin payload + `status`/`session-end` subcommands (`apps/workspace/src/main.js`)

**Files:**
- Modify: `apps/workspace/src/main.js`
- Test: `apps/workspace/test/main.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `apps/workspace/test/main.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/main.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function ttyStdin() {
  return { isTTY: true };
}

function pipedStdin(payload) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
  };
}

function emptyPipedStdin() {
  return { isTTY: false, async *[Symbol.asyncIterator]() {} };
}

function malformedPipedStdin() {
  return { isTTY: false, async *[Symbol.asyncIterator]() { yield Buffer.from('{not json'); } };
}

const config = {
  defaultTargets: ['claude'],
  repos: [
    { name: 'a', url: 'git@host:a.git', technologies: ['nestjs'], targets: ['claude'] },
    { name: 'b', url: 'git@host:b.git', technologies: ['nestjs'], targets: ['claude'] },
  ],
};

test('main requires --config or --config-repo', async () => {
  await assert.rejects(
    () => main([], { loadConfig: async () => config, logger: silentLogger() }),
    /Missing required --config <path> or --config-repo/,
  );
});

test('main can load config from a repo via --config-repo', async () => {
  let repoArgs;
  let received;
  await main(['--config-repo', 'git@github.com:o/ai-config.git', '--config-file', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfigFromRepo: async (url, opts) => { repoArgs = { url, opts }; return config; },
    runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(repoArgs.url, 'git@github.com:o/ai-config.git');
  assert.equal(repoArgs.opts.configFile, 'repos.json');
  assert.equal(received.workspaceDir, path.resolve('/tmp/ws'));
});

test('main requires --workspace', async () => {
  await assert.rejects(
    () => main(['--config', 'repos.json'], { loadConfig: async () => config, logger: silentLogger() }),
    /Missing required --workspace/,
  );
});

test('main loads config, resolves the workspace path, and forwards flags', async () => {
  let received;
  const code = await main(
    ['--config', 'repos.json', '--workspace', 'ws', '--editor', 'vscode', '--repo', 'a', '--worktree', 'feat/z', '--no-install', '--dry-run', '--offline'],
    {
      loadConfig: async (p) => { assert.equal(p, 'repos.json'); return config; },
      runBootstrap: async (cfg, opts) => { received = opts; return {}; },
      logger: silentLogger(),
    },
  );

  assert.equal(code, 0);
  assert.equal(received.editor, 'vscode');
  assert.equal(received.repoFilter, 'a');
  assert.equal(received.worktree, 'feat/z');
  assert.equal(received.install, false);
  assert.equal(received.dryRun, true);
  assert.equal(received.offline, true);
  assert.equal(received.workspaceDir, path.resolve('ws'));
});

test('main prompts for a single repo and forwards onExisting on an interactive TTY', async () => {
  let promptedWith;
  let received;
  const onExisting = async () => 'reuse';
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config,
    isInteractive: true,
    selectRepo: async (repos) => { promptedWith = repos; return 'b'; },
    onExisting,
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.deepEqual(promptedWith, config.repos);
  assert.equal(received.repoFilter, 'b');
  assert.equal(received.onExisting, onExisting);
});

test('main does not prompt when --repo is provided even interactively', async () => {
  let prompted = false;
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws', '--repo', 'a'], {
    loadConfig: async () => config,
    isInteractive: true,
    selectRepo: async () => { prompted = true; return 'b'; },
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.equal(prompted, false);
  assert.equal(received.repoFilter, 'a');
});

test('main routes the status subcommand to setSessionStatus using the piped session id', async () => {
  const calls = [];
  const code = await main(['status', 'oc-be', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async (boardPath, repo, sessionId, state, o) => { calls.push({ boardPath, repo, sessionId, state, o }); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop' }),
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    boardPath: path.resolve('/b.json'), repo: 'oc-be', sessionId: 'sess-1', state: 'question', o: { lastEvent: 'Stop' },
  }]);
});

test('status subcommand requires repo and state', async () => {
  await assert.rejects(
    () => main(['status', 'oc-be', '--board', '/b.json'], { setSessionStatus: async () => {}, logger: silentLogger() }),
    /Usage: .*status <repo> <state>/,
  );
});

test('status subcommand defaults lastEvent to manual and falls back to a "manual" session on a TTY', async () => {
  let received;
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId, _s, o) => { receivedSessionId = sessionId; received = o; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
  assert.deepEqual(received, { lastEvent: 'manual' });
});

test('status subcommand extracts and truncates the title, and forwards the full lastPrompt, on UserPromptSubmit', async () => {
  let received;
  const longPrompt = 'x'.repeat(80);
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: longPrompt }),
    logger: silentLogger(),
  });
  assert.equal(received.title, `${'x'.repeat(59)}…`);
  assert.equal(received.lastPrompt, longPrompt);
});

test('status subcommand does not truncate a prompt at or under 60 characters', async () => {
  let received;
  const shortPrompt = 'x'.repeat(60);
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: shortPrompt }),
    logger: silentLogger(),
  });
  assert.equal(received.title, shortPrompt);
});

test('status subcommand skips title/lastPrompt when UserPromptSubmit has no prompt string', async () => {
  let received;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit' }),
    logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'UserPromptSubmit' });
});

test('status subcommand does not forward a title/lastPrompt on Notification or Stop', async () => {
  let received;
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop' }),
    logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'Stop' });
});

test('status subcommand falls back to an empty payload when stdin is piped but empty', async () => {
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: emptyPipedStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('status subcommand falls back to an empty payload when stdin contains invalid JSON', async () => {
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: malformedPipedStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('main routes the session-end subcommand to removeSession using the piped session id', async () => {
  const calls = [];
  const code = await main(['session-end', 'oc-be', '--board', '/b.json'], {
    removeSession: async (boardPath, repo, sessionId) => { calls.push({ boardPath, repo, sessionId }); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ boardPath: path.resolve('/b.json'), repo: 'oc-be', sessionId: 'sess-1' }]);
});

test('session-end subcommand requires repo', async () => {
  await assert.rejects(
    () => main(['session-end', '--board', '/b.json'], { removeSession: async () => {}, logger: silentLogger() }),
    /Usage: .*session-end <repo>/,
  );
});

test('session-end subcommand falls back to a "manual" session on a TTY', async () => {
  let receivedSessionId;
  await main(['session-end', 'a', '--board', '/b.json'], {
    removeSession: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('main accepts an explicit bootstrap subcommand', async () => {
  let received;
  await main(['bootstrap', '--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config, runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(received.editor, 'claude');
});

test('main defaults editor to claude and install to true', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config,
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.equal(received.editor, 'claude');
  assert.equal(received.install, true);
  assert.equal(received.dryRun, false);
  assert.equal(received.offline, false);
  assert.equal(received.repoFilter, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace`
Expected: FAIL — `main.js` still calls `setStatus` (no `sessionId`), has no `session-end` subcommand, and doesn't read stdin.

- [ ] **Step 3: Implement the CLI changes**

Replace `apps/workspace/src/main.js`:

```js
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigSource } from '@linktogo/ai-config';
import {
  bootstrap,
  resolveBoardPath,
  setSessionStatus as defaultSetSessionStatus,
  removeSession as defaultRemoveSession,
} from '@linktogo/ai-workspace-bootstrap';

const TITLE_MAX = 60;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function readStdinJSON(stdin) {
  if (stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function main(argv, deps = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'status') return runStatus(rest, deps);
  if (sub === 'session-end') return runSessionEnd(rest, deps);
  if (sub === 'bootstrap') return runBootstrapMain(rest, deps);
  return runBootstrapMain(argv, deps);
}

async function runStatus(argv, deps = {}) {
  const { setSessionStatus = defaultSetSessionStatus, logger = console, stdin = process.stdin } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' }, event: { type: 'string' } },
  });
  const [repo, state] = positionals;
  if (!repo || !state) throw new Error('Usage: ai-workspace status <repo> <state> [--board <path>] [--event <name>]');
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = await readStdinJSON(stdin);
  const sessionId = payload.session_id ?? 'manual';
  const opts = { lastEvent: values.event ?? 'manual' };
  if (payload.hook_event_name === 'UserPromptSubmit' && typeof payload.prompt === 'string') {
    opts.title = truncate(payload.prompt, TITLE_MAX);
    opts.lastPrompt = payload.prompt;
  }
  await setSessionStatus(boardPath, repo, sessionId, state, opts);
  logger.log(`${repo} [${sessionId}] → ${state}`);
  return 0;
}

async function runSessionEnd(argv, deps = {}) {
  const { removeSession = defaultRemoveSession, logger = console, stdin = process.stdin } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' } },
  });
  const [repo] = positionals;
  if (!repo) throw new Error('Usage: ai-workspace session-end <repo> [--board <path>]');
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = await readStdinJSON(stdin);
  const sessionId = payload.session_id ?? 'manual';
  await removeSession(boardPath, repo, sessionId);
  logger.log(`${repo} [${sessionId}] session ended`);
  return 0;
}

async function runBootstrapMain(argv, deps = {}) {
  const {
    loadConfig,
    loadConfigFromRepo,
    runBootstrap = bootstrap,
    selectRepo,
    onExisting,
    isInteractive = process.stdin.isTTY,
    logger = console,
  } = deps;

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'config-repo': { type: 'string' },
      'config-file': { type: 'string' },
      workspace: { type: 'string' },
      editor: { type: 'string', default: 'claude' },
      repo: { type: 'string' },
      worktree: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
    },
  });

  const config = await resolveConfigSource(
    { config: values.config, configRepo: values['config-repo'], configFile: values['config-file'] },
    { loadConfig, loadConfigFromRepo },
  );
  if (!values.workspace) throw new Error('Missing required --workspace <dir>');

  // Without an explicit --repo, prompt for a single project to load when
  // running interactively; non-interactive runs keep bootstrapping every repo.
  let repoFilter = values.repo;
  if (!repoFilter && isInteractive) {
    repoFilter = await selectRepo(config.repos);
  }

  await runBootstrap(config, {
    workspaceDir: path.resolve(values.workspace),
    editor: values.editor,
    repoFilter,
    worktree: values.worktree,
    install: !values['no-install'],
    dryRun: values['dry-run'],
    offline: values.offline,
    onExisting: isInteractive ? onExisting : undefined,
    hookCommand: fileURLToPath(new URL('../bin/workspace.js', import.meta.url)),
    logger,
  });

  return 0;
}
```

Note: `status subcommand requires repo and state` and `session-end subcommand requires repo` intentionally don't inject `stdin` — both throw before `readStdinJSON` is ever called, so they'd hang on a real (unmocked) `process.stdin` read if that validation ever moved later in the function. Keep the validation ahead of the stdin read.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test workspace`
Expected: PASS, 100% coverage (lines/functions/branches) on `apps/workspace/src/main.js`.

- [ ] **Step 5: Commit**

```bash
git add apps/workspace/src/main.js apps/workspace/test/main.test.js
git commit -m "feat(workspace): read session id/prompt from hook stdin for status and session-end"
```

---

### Task 4: Board server default shape bump to v2 (`apps/board/server.js`)

**Files:**
- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing test change**

In `apps/board/server.test.js`, update the missing-file expectation:

```js
test('GET /api/board returns an empty board when the file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'nope.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.deepEqual(await res.json(), { version: 2, repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — the missing-board test now expects `version: 2` but the server still returns `version: 1`.

- [ ] **Step 3: Bump the default in `server.js`**

In `apps/board/server.js`, inside `serveBoard`, change:

```js
    body = JSON.stringify({ version: 1, repos: {} });
```

to:

```js
    body = JSON.stringify({ version: 2, repos: {} });
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS, full suite (server + front-end) green.

- [ ] **Step 5: Commit**

```bash
git add apps/board/server.js apps/board/server.test.js
git commit -m "feat(board): default an empty board to the v2 sessions shape"
```

---

## Lot 2 — Frontend (`apps/board/src`)

### Task 5: Per-session transition diffing (`useBoard.js`)

**Files:**
- Modify: `apps/board/src/useBoard.js`
- Test: `apps/board/src/useBoard.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `apps/board/src/useBoard.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useBoard } from './useBoard.js';

test('useBoard fetches immediately and exposes repos', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 2, repos: { a: { sessions: {} } } }) });
  const { repos, stop } = useBoard({ intervalMs: 1000, fetchImpl });
  await nextTick();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/board');
  expect(repos.value).toEqual({ a: { sessions: {} } });
  stop();
});

test('useBoard polls on the interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ version: 2, repos: {} }) });
  const { stop } = useBoard({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3); // immediate + 2 ticks
  stop();
  vi.useRealTimers();
});

test('useBoard reports no transitions on the first fetch (baseline)', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ repos: { a: { sessions: { s1: { status: 'question' } } } } }) });
  const { transitions, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(transitions.value).toEqual([]);
  stop();
});

test('useBoard detects session transitions into question/done on later fetches', async () => {
  const responses = [
    { repos: { a: { sessions: { s1: { status: 'inprogress', title: 'fix login' } } }, b: { sessions: { s2: { status: 'todo' } } } } },
    { repos: { a: { sessions: { s1: { status: 'question', title: 'fix login' } } }, b: { sessions: { s2: { status: 'done' } } } } },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve({ json: async () => responses.shift() }));
  const { transitions, refresh, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(transitions.value).toEqual([
    { name: 'a', sessionId: 's1', title: 'fix login', status: 'question' },
    { name: 'b', sessionId: 's2', title: undefined, status: 'done' },
  ]);
  stop();
});

test('useBoard does not report a transition for a session whose status is unchanged', async () => {
  const responses = [
    { repos: { a: { sessions: { s1: { status: 'question', title: 't' } } } } },
    { repos: { a: { sessions: { s1: { status: 'question', title: 't' } } } } },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve({ json: async () => responses.shift() }));
  const { transitions, refresh, stop } = useBoard({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(transitions.value).toEqual([]);
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
Expected: FAIL — `diffTransitions` still reads a flat `r.status`, so sessions-shaped fixtures produce no transitions where the new tests expect some.

- [ ] **Step 3: Implement the per-session diff**

In `apps/board/src/useBoard.js`, replace `diffTransitions`:

```js
function diffTransitions(prev, next) {
  const out = [];
  for (const [name, repoEntry] of Object.entries(next)) {
    const prevSessions = prev[name]?.sessions ?? {};
    for (const [sessionId, session] of Object.entries(repoEntry.sessions ?? {})) {
      if (NOTIFY_STATES.includes(session.status) && prevSessions[sessionId]?.status !== session.status) {
        out.push({ name, sessionId, title: session.title, status: session.status });
      }
    }
  }
  return out;
}
```

The rest of `useBoard.js` (the `useBoard()` function itself) is unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useBoard.js apps/board/src/useBoard.test.js
git commit -m "feat(board): diff session transitions instead of repo-level status"
```

---

### Task 6: `SessionRow.vue` (new)

**Files:**
- Create: `apps/board/src/SessionRow.vue`
- Test: `apps/board/src/SessionRow.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/board/src/SessionRow.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionRow from './SessionRow.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');

function session(overrides = {}) {
  return {
    sessionId: 's1',
    status: 'inprogress',
    lastEvent: 'UserPromptSubmit',
    updatedAt: '2026-06-21T09:59:00.000Z',
    title: 'fix login redirect',
    lastPrompt: 'fix login redirect',
    events: [],
    ...overrides,
  };
}

test('renders the title and a relative time', () => {
  const w = mount(SessionRow, { props: { session: session(), now } });
  expect(w.text()).toContain('fix login redirect');
  expect(w.text()).toContain('il y a 1 min');
});

test('emits "open" with the session id on click', async () => {
  const w = mount(SessionRow, { props: { session: session(), now } });
  await w.get('[data-test=session-row]').trigger('click');
  expect(w.emitted('open')[0]).toEqual(['s1']);
});

test('clips a prompt longer than 140 characters and shows a toggle', () => {
  const long = 'x'.repeat(200);
  const w = mount(SessionRow, { props: { session: session({ lastPrompt: long }), now } });
  expect(w.text()).toContain(`${'x'.repeat(140)}…`);
  expect(w.find('[data-test=toggle-prompt]').exists()).toBe(true);
});

test('does not show a toggle when the prompt is 140 characters or shorter', () => {
  const w = mount(SessionRow, { props: { session: session({ lastPrompt: 'x'.repeat(140) }), now } });
  expect(w.find('[data-test=toggle-prompt]').exists()).toBe(false);
});

test('toggling expands and collapses the full prompt without emitting open', async () => {
  const long = 'y'.repeat(200);
  const w = mount(SessionRow, { props: { session: session({ lastPrompt: long }), now } });
  await w.get('[data-test=toggle-prompt]').trigger('click');
  expect(w.text()).toContain(long);
  expect(w.emitted('open')).toBeUndefined();
  await w.get('[data-test=toggle-prompt]').trigger('click');
  expect(w.text()).not.toContain(long);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — `SessionRow.vue` doesn't exist yet.

- [ ] **Step 3: Implement `SessionRow.vue`**

Create `apps/board/src/SessionRow.vue`:

```vue
<script setup>
import { ref, computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';

const PROMPT_CLIP = 140;

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open']);

const expanded = ref(false);
const when = computed(() => relativeTime(props.session.updatedAt, props.now));
const prompt = computed(() => props.session.lastPrompt ?? '');
const overflows = computed(() => prompt.value.length > PROMPT_CLIP);
const displayedPrompt = computed(() => (
  expanded.value || !overflows.value ? prompt.value : `${prompt.value.slice(0, PROMPT_CLIP)}…`
));

function open() { emit('open', props.session.sessionId); }
function toggle(e) { e.stopPropagation(); expanded.value = !expanded.value; }
</script>

<template>
  <div
    role="button"
    tabindex="0"
    data-test="session-row"
    class="py-1.5 cursor-pointer"
    @click="open"
    @keydown.enter="open"
    @keydown.space.prevent="open"
  >
    <div class="font-medium text-slate-800 text-sm truncate">{{ session.title ?? '(sans titre)' }}</div>
    <div class="text-xs text-slate-500">{{ session.lastEvent }} · {{ when }}</div>
    <p v-if="prompt" class="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
      {{ displayedPrompt }}
      <button
        v-if="overflows"
        type="button"
        data-test="toggle-prompt"
        class="text-blue-600 hover:underline"
        @click="toggle"
      >{{ expanded ? 'voir moins' : 'voir plus' }}</button>
    </p>
  </div>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/SessionRow.vue apps/board/src/SessionRow.test.js
git commit -m "feat(board): add SessionRow with a 140-char expandable prompt"
```

---

### Task 7: Session-grouped cards & board wiring (`Card.vue`, `Column.vue`, `App.vue`)

These three files change together: `Card.vue`'s prop contract moves from a single `repo` object to a `sessions` array + `status`, `Column.vue` threads that through, and `App.vue` is what actually groups sessions per column and feeds the new shape in. Doing them separately would leave `App.test.js` broken between commits, so this task lands all three together and both test files are rewritten before either implementation file changes.

**Files:**
- Modify: `apps/board/src/Card.vue`
- Modify: `apps/board/src/Column.vue`
- Modify: `apps/board/src/App.vue`
- Test: `apps/board/src/Card.test.js`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `apps/board/src/Card.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Card from './Card.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');

function session(overrides = {}) {
  return {
    sessionId: 's1', status: 'todo', lastEvent: 'init',
    updatedAt: '2026-06-21T09:59:00.000Z', title: 'fix login', lastPrompt: 'fix login', events: [],
    ...overrides,
  };
}

test('renders the repo name and one row per session', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session(), session({ sessionId: 's2', title: 'add tests' })], status: 'inprogress', now } });
  expect(w.text()).toContain('oc-be');
  expect(w.text()).toContain('fix login');
  expect(w.text()).toContain('add tests');
  expect(w.findAll('[data-test=session-row]')).toHaveLength(2);
});

test('shows a placeholder when the repo has no active sessions', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [], status: 'todo', now } });
  expect(w.text()).toContain('Aucune session active');
});

test('highlights a question card', () => {
  const w = mount(Card, { props: { name: 'oc-auth', sessions: [session()], status: 'question', now } });
  expect(w.classes().join(' ')).toContain('ring-amber-200');
});

test('emits "open" with the repo name and session id when a row is clicked', async () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now } });
  await w.get('[data-test=session-row]').trigger('click');
  expect(w.emitted('open')[0]).toEqual([{ name: 'oc-be', sessionId: 's1' }]);
});
```

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
      version: 2,
      repos: {
        a: { sessions: {} }, // idle repo -> todo placeholder card
        b: { sessions: { s1: { status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 'fix login', lastPrompt: 'fix login', events: [] } } },
        c: { sessions: { s2: { status: 'question', lastEvent: 'Notification', updatedAt: 'T', title: 'review PR', lastPrompt: 'review PR', events: [] } } },
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
  expect(columns[2].text()).toContain('(2)'); // repos b and c both have a session in "question"
  expect(wrapper.text()).toContain('a');
  expect(wrapper.text()).toContain('b');
});

test('App renders the summary header and filter bar', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  expect(wrapper.text()).toContain('repos');
  expect(wrapper.find('[data-test=search]').exists()).toBe(true);
});

test('clicking a session row opens the detail panel', async () => {
  const wrapper = mount(App, { props: { fetchImpl: routedFetch(), intervalMs: 100000 } });
  await settle();
  await wrapper.get('[data-test=session-row]').trigger('click');
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
Expected: FAIL — `Card.vue` still expects a `repo` prop, and `App.vue` still groups by a flat `r.status`.

- [ ] **Step 3: Implement `Card.vue`**

Replace `apps/board/src/Card.vue`:

```vue
<script setup>
import { computed } from 'vue';
import SessionRow from './SessionRow.vue';

const props = defineProps({
  name: { type: String, required: true },
  sessions: { type: Array, required: true }, // [{ sessionId, title, lastPrompt, updatedAt, lastEvent, ... }]
  status: { type: String, required: true },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open']);

const isQuestion = computed(() => props.status === 'question');

function open(sessionId) {
  emit('open', { name: props.name, sessionId });
}
</script>

<template>
  <div
    :class="['rounded-md bg-white shadow-sm border p-3',
             isQuestion ? 'border-amber-400 ring-4 ring-amber-200' : 'border-slate-200']"
  >
    <div class="font-medium text-slate-800">{{ name }}</div>
    <p v-if="sessions.length === 0" class="mt-1 text-xs text-slate-400">Aucune session active</p>
    <div v-else class="mt-2 flex flex-col divide-y divide-slate-100">
      <SessionRow v-for="s in sessions" :key="s.sessionId" :session="s" :now="now" @open="open" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: Implement `Column.vue`**

Replace `apps/board/src/Column.vue`:

```vue
<script setup>
import Card from './Card.vue';
defineProps({
  title: { type: String, required: true },
  status: { type: String, required: true },
  accent: { type: String, default: 'bg-slate-100' },
  entries: { type: Array, required: true }, // [{ name, sessions }]
  now: { type: Number, default: () => Date.now() },
});
defineEmits(['open']);
</script>

<template>
  <section class="min-w-0">
    <h2 :class="['rounded-t-md px-3 py-2 text-sm font-semibold text-slate-700', accent]">
      {{ title }} <span class="text-slate-400">({{ entries.length }})</span>
    </h2>
    <div class="flex flex-col gap-2 bg-slate-50 p-2 rounded-b-md min-h-[4rem]">
      <Card v-for="e in entries" :key="e.name" :name="e.name" :sessions="e.sessions" :status="status" :now="now" @open="$emit('open', $event)" />
    </div>
  </section>
</template>
```

- [ ] **Step 5: Implement `App.vue`**

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
const selected = ref(null); // { name, sessionId } | null

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

const selectedRepo = computed(() => (selected.value ? repos.value[selected.value.name] : null));
const selectedSession = computed(() => selectedRepo.value?.sessions?.[selected.value?.sessionId] ?? null);
const selectedMeta = computed(() => (selected.value ? config.value[selected.value.name] ?? null : null));
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-4">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <h1 class="text-lg font-bold text-slate-800">ai-sync · workspace board</h1>
      <div class="flex items-center gap-2 flex-wrap">
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

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <Column
        v-for="c in grouped" :key="c.status"
        :title="c.title" :status="c.status" :accent="c.accent" :entries="c.entries" :now="now"
        @open="selected = $event"
      />
    </div>

    <RepoDetail
      :name="selected?.name ?? null" :session="selectedSession" :meta="selectedMeta" :now="now"
      @close="selected = null"
    />
  </main>
</template>
```

Note: `RepoDetail.vue` still takes the old `repo` prop at this point in the plan (Task 8 renames it to `session`). Passing `:session="selectedSession"` here means `RepoDetail`'s detail content will look empty until Task 8 lands — that's expected and doesn't fail any test (`App.test.js`'s detail-panel test only checks that the panel opens, not its content).

- [ ] **Step 6: Run to verify pass**

Run: `npm run test:board`
Expected: PASS — `Card.test.js` and `App.test.js` both green, full suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/board/src/Card.vue apps/board/src/Column.vue apps/board/src/App.vue apps/board/src/Card.test.js apps/board/src/App.test.js
git commit -m "feat(board): group session cards per column, one row per session"
```

---

### Task 8: `RepoDetail.vue` per-session panel

**Files:**
- Modify: `apps/board/src/RepoDetail.vue`
- Test: `apps/board/src/RepoDetail.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `apps/board/src/RepoDetail.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RepoDetail from './RepoDetail.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');
const session = {
  status: 'question', lastEvent: 'waiting', updatedAt: '2026-06-21T10:00:00.000Z',
  title: 'fix auth redirect', lastPrompt: 'fix the auth redirect loop on logout',
  events: [
    { event: 'waiting input', at: '2026-06-21T09:59:48.000Z' },
    { event: 'edit src/', at: '2026-06-21T09:57:00.000Z' },
  ],
};
const meta = { url: 'https://h/oc-auth.git', technologies: ['nestjs'], targets: ['claude'] };

test('renders url, technologies, the session title/prompt, and the event timeline', () => {
  const w = mount(RepoDetail, { props: { name: 'oc-auth', session, meta, now } });
  expect(w.get('a').attributes('href')).toBe('https://h/oc-auth.git');
  expect(w.text()).toContain('nestjs');
  expect(w.text()).toContain('fix auth redirect');
  expect(w.text()).toContain('fix the auth redirect loop on logout');
  expect(w.text()).toContain('waiting input');
  expect(w.text()).toContain('il y a 12 s');
});

test('renders nothing when name is null', () => {
  const w = mount(RepoDetail, { props: { name: null, session: null, meta: null, now } });
  expect(w.find('aside').exists()).toBe(false);
});

test('emits close on overlay click and on Escape', async () => {
  const w = mount(RepoDetail, { props: { name: 'oc-auth', session, meta, now }, attachTo: document.body });
  await w.get('[data-test=overlay]').trigger('click');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(w.emitted('close').length).toBeGreaterThanOrEqual(2);
  w.unmount();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — `RepoDetail.vue` still reads a `repo` prop, so `session`-only tests find no title/prompt/events rendered.

- [ ] **Step 3: Implement `RepoDetail.vue`**

Replace `apps/board/src/RepoDetail.vue`:

```vue
<script setup>
import { onMounted, onUnmounted } from 'vue';
import { relativeTime } from './useRelativeTime.js';

defineProps({
  name: { type: String, default: null },
  session: { type: Object, default: null },
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
    <aside class="absolute right-0 top-0 h-full w-full sm:w-80 max-w-full bg-white shadow-xl p-4 overflow-y-auto">
      <button class="float-right text-slate-400 hover:text-slate-600" @click="emit('close')">✕</button>
      <h2 class="font-bold text-slate-800">{{ name }}</h2>
      <p v-if="session?.title" class="text-sm text-slate-600 mt-1">{{ session.title }}</p>
      <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
         class="text-sm text-blue-600 underline break-all">{{ meta.url }}</a>
      <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
        <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs bg-slate-100 px-2 py-0.5 rounded">{{ t }}</span>
        <span v-for="t in (meta.targets || [])" :key="t" class="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{{ t }}</span>
      </div>
      <p v-if="session?.lastPrompt" class="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{{ session.lastPrompt }}</p>
      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">Historique</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (session?.events || [])" :key="i" class="text-xs text-slate-600">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS, full suite green (this also fills in `RepoDetail`'s content for the session selected via Task 7's `App.vue`).

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/RepoDetail.vue apps/board/src/RepoDetail.test.js
git commit -m "feat(board): show the selected session's title/prompt/history in the detail panel"
```

---

### Task 9: `SummaryHeader.vue` session-level counts

**Files:**
- Modify: `apps/board/src/SummaryHeader.vue`
- Test: `apps/board/src/SummaryHeader.test.js`

- [ ] **Step 1: Write the failing tests**

Replace `apps/board/src/SummaryHeader.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SummaryHeader from './SummaryHeader.vue';

const repos = {
  a: { sessions: {} }, // idle repo -> counts as one "todo" card
  b: { sessions: { s1: { status: 'inprogress' } } },
  c: { sessions: { s2: { status: 'question' } } },
  d: { sessions: { s3: { status: 'done' }, s4: { status: 'done' } } }, // two sessions on one repo
};

test('shows total and per-status counts', () => {
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.text()).toContain('5');         // total: a(1) + b(1) + c(1) + d(2)
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
Expected: FAIL — `SummaryHeader.vue` still reads a flat `r.status`, so every count comes back 0 against sessions-shaped fixtures.

- [ ] **Step 3: Implement `SummaryHeader.vue`**

Replace `apps/board/src/SummaryHeader.vue`:

```vue
<script setup>
import { computed } from 'vue';

const props = defineProps({ repos: { type: Object, required: true } });

// A repo with zero active sessions counts as one "todo" card (same
// placeholder behavior the board itself shows); otherwise every session
// counts individually, so a repo with two concurrent sessions counts twice.
const counts = computed(() => {
  const c = { todo: 0, inprogress: 0, question: 0, done: 0 };
  for (const repoEntry of Object.values(props.repos)) {
    const sessions = Object.values(repoEntry.sessions ?? {});
    if (sessions.length === 0) { c.todo += 1; continue; }
    for (const s of sessions) if (c[s.status] !== undefined) c[s.status] += 1;
  }
  return c;
});
const total = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0));
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

The `repos` label is kept as-is (not renamed to "sessions") deliberately — `App.vue`'s existing `App.test.js` assertion `toContain('repos')` depends on this text, and the count only diverges from "number of repos" when a repo has more than one concurrent session, which is exactly this feature's edge case, not the common case.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/SummaryHeader.vue apps/board/src/SummaryHeader.test.js
git commit -m "feat(board): count summary header stats per session"
```

---

### Task 10: Session-aware notifications (`useNotifications.js`)

**Files:**
- Modify: `apps/board/src/useNotifications.js`
- Test: `apps/board/src/useNotifications.test.js`

- [ ] **Step 1: Write the failing test**

In `apps/board/src/useNotifications.test.js`, add this test (keep all existing tests unchanged — they use transitions without a `title`, which still works via the fallback):

```js
test('includes the session title in the notification when present', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('granted');
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' } });
  transitions.value = [{ name: 'oc-auth', sessionId: 's1', title: 'fix login redirect', status: 'question' }];
  await nextTick();
  expect(notifier.instances[0].title).toBe('oc-auth · fix login redirect → question');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:board`
Expected: FAIL — the new test expects `'oc-auth · fix login redirect → question'` but the notifier still only receives `'oc-auth → question'`.

- [ ] **Step 3: Implement the title-aware notification body**

In `apps/board/src/useNotifications.js`, replace the transitions `watch`:

```js
  watch(transitions, (list) => {
    if (!list || list.length === 0) return;
    if (notifier && permission.value === 'granted') {
      for (const t of list) {
        const label = t.title ? `${t.name} · ${t.title}` : t.name;
        new notifier(`${label} → ${t.status}`, { body: bodyFor(t.status) });
      }
    }
    if (soundOn.value) playSound();
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:board`
Expected: PASS, full suite green — this is the last frontend task, so this run should be the whole `apps/board` suite passing end-to-end against the new session-based data model.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useNotifications.js apps/board/src/useNotifications.test.js
git commit -m "feat(board): name the session in transition notifications"
```

---

## Self-Review Notes

- **Spec coverage:** every "Decisions" bullet in the design doc maps to a task — grouped-by-repo cards with per-column session filtering → Task 7; `session_id`-keyed sessions → Task 1; stable title from the first `UserPromptSubmit` → Task 1 (storage) + Task 3 (CLI extraction/truncation); `lastPrompt` 140-char expandable → Task 1 (storage) + Task 6 (`SessionRow.vue`); `"manual"` pseudo-session fallback → Task 3; `SessionEnd` hook removal → Task 2 (hook wiring) + Task 3 (`removeSession` wiring); idle repo placeholder → Task 1 (`initRepos`) + Task 7 (`entriesFor`); disposable/reset `board.json` migration → Task 1 (`normalizeRepoEntry`); per-session notifications/counts → Task 5 (`useBoard.js`), Task 9 (`SummaryHeader.vue`), Task 10 (`useNotifications.js`).
- **Placeholder scan:** none — every step has complete, runnable code.
- **Type consistency:** `setSessionStatus(boardPath, repo, sessionId, state, opts)` and `removeSession(boardPath, repo, sessionId, opts)` signatures match exactly across Task 1's implementation, Task 1's tests, and Task 3's CLI call sites. Session object shape (`{ status, updatedAt, lastEvent, title, lastPrompt, events }`) is identical in Task 1, and every frontend consumer (Task 5's `diffTransitions`, Task 6's `SessionRow`, Task 7's `entriesFor`/`Card`, Task 8's `RepoDetail`) reads the same field names. The `{ name, sessionId }` selection payload is emitted by `SessionRow`→`Card`→`Column`→`App` (Tasks 6–7) with the same shape `App.vue` consumes for `selectedSession`.
- **Sequencing note (not in the original design doc):** Task 7 merges `Card.vue`, `Column.vue`, and `App.vue` into one task instead of three, because `Card.vue`'s prop contract change (`repo` object → `sessions` array + `status`) is a breaking change that `App.test.js` would otherwise fail on between commits. `SessionRow.vue`, `RepoDetail.vue`, `SummaryHeader.vue`, `useBoard.js`, and `useNotifications.js` were verified independent (each only unit-tests itself and doesn't change a prop/shape another already-landed file's tests assert on), so they stay as separate tasks per the design doc's file list.
- **Deviation from the approved design, noted here rather than re-opening brainstorming:** `SummaryHeader.vue`'s total label stays "repos" instead of being renamed to "sessions" — the design doc only specified *how the count is computed*, not the label text, and renaming it would have forced an unrelated `App.test.js` edit for no behavioral benefit (the label already reads correctly in the common single-session-per-repo case).
