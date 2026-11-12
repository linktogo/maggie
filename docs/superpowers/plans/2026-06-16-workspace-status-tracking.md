# Workspace Status Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each workspace repo's kanban status (`todo`/`inprogress`/`question`/`done`) in an atomic `board.json`, updated automatically by Claude Code hooks and explicitly for `done`.

**Architecture:** A focused `src/board.js` owns the state file (atomic read-modify-write, transitions, init). A focused `src/hooks.js` generates/merges each checkout's `.claude/settings.local.json`. The `ai-workspace` CLI (`src/workspace.js`) gains subcommand routing: `status` writes a transition, `bootstrap` additionally initializes the board and installs hooks. The board server/viewer is a separate plan that only reads `board.json`.

**Tech Stack:** Node.js ≥22 ESM, `node:test`, `node:util` `parseArgs`, zero runtime deps. The repo enforces **100% line/function/branch coverage on `src/**`** (`npm test`), so every branch below has a test.

---

## File Structure

- Create: `src/board.js` — state model: `STATES`, `resolveBoardPath`, `readBoard`, `writeBoard`, `setStatus`, `initRepos`.
- Create: `src/hooks.js` — `hookSettings`, `installHooks` (settings.local.json generation + merge).
- Create: `test/board.test.js`, `test/hooks.test.js`.
- Modify: `src/workspace.js` — subcommand routing in `main`; new `runStatus`; `bootstrap` gains board-init + hook-install.
- Modify: `test/workspace.test.js` — routing + new bootstrap behavior tests.

Note on injectable IO: every function that touches the filesystem or clock takes a final options object with injectable deps (`read`, `write`, `move`, `ensureDir`, `now`, `tmpSuffix`), mirroring the existing `bootstrap`/`createRepo` style. This is what lets the tests hit every branch without real IO.

---

## Task 1: `board.js` — STATES and `resolveBoardPath`

**Files:**
- Create: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/board.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STATES, resolveBoardPath } from '../src/board.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `Cannot find module '../src/board.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/board.js
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const STATES = ['todo', 'inprogress', 'question', 'done'];

export function resolveBoardPath({ board, env = process.env } = {}) {
  const p = board || env.AI_SYNC_BOARD;
  if (!p) throw new Error('No board path (pass --board <path> or set AI_SYNC_BOARD)');
  return path.resolve(p);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add src/board.js test/board.test.js
rtk git commit -m "feat: board state path resolution and STATES"
```

---

## Task 2: `board.js` — `readBoard`

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/board.test.js
import { readBoard } from '../src/board.js';

test('readBoard parses an existing board and fills defaults', async () => {
  const read = async () => JSON.stringify({ repos: { a: { status: 'done' } } });
  assert.deepEqual(await readBoard('/x', { read }), { version: 1, repos: { a: { status: 'done' } } });
});

test('readBoard returns an empty board when the file is missing', async () => {
  const read = async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  assert.deepEqual(await readBoard('/x', { read }), { version: 1, repos: {} });
});

test('readBoard rethrows non-ENOENT errors', async () => {
  const read = async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; };
  await assert.rejects(() => readBoard('/x', { read }), /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `readBoard` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/board.js
export async function readBoard(boardPath, { read = readFile } = {}) {
  try {
    const parsed = JSON.parse(await read(boardPath, 'utf8'));
    return { version: 1, repos: {}, ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, repos: {} };
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/board.js test/board.test.js
rtk git commit -m "feat: readBoard with missing-file fallback"
```

---

## Task 3: `board.js` — `writeBoard` (atomic)

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/board.test.js
import { writeBoard } from '../src/board.js';

test('writeBoard ensures the dir, writes a temp file, then renames (atomic)', async () => {
  const calls = [];
  await writeBoard('/d/board.json', { version: 1, repos: {} }, {
    ensureDir: async (dir, opts) => calls.push(['ensureDir', dir, opts]),
    write: async (file, data) => calls.push(['write', file, data]),
    move: async (from, to) => calls.push(['move', from, to]),
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(calls, [
    ['ensureDir', '/d', { recursive: true }],
    ['write', '/d/board.json.tmp', '{\n  "version": 1,\n  "repos": {}\n}\n'],
    ['move', '/d/board.json.tmp', '/d/board.json'],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `writeBoard` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/board.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/board.js test/board.test.js
rtk git commit -m "feat: atomic writeBoard"
```

---

## Task 4: `board.js` — `setStatus`

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/board.test.js
import { setStatus } from '../src/board.js';

test('setStatus reads, applies the transition with timestamp + event, and writes', async () => {
  let written;
  const board = await setStatus('/x', 'example-api', 'question', {
    lastEvent: 'Notification',
    now: () => '2026-06-16T10:00:00Z',
    read: async () => JSON.stringify({ version: 1, repos: { 'example-api': { status: 'inprogress' } } }),
    write: async (_f, data) => { written = data; },
    move: async () => {},
    ensureDir: async () => {},
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos['example-api'], {
    status: 'question', updatedAt: '2026-06-16T10:00:00Z', lastEvent: 'Notification',
  });
  assert.match(written, /"status": "question"/);
});

test('setStatus defaults lastEvent to manual', async () => {
  const board = await setStatus('/x', 'a', 'done', {
    now: () => 'T', read: async () => '{"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.lastEvent, 'manual');
});

test('setStatus rejects an invalid state', async () => {
  await assert.rejects(() => setStatus('/x', 'a', 'bogus', {}), /Invalid state "bogus"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `setStatus` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/board.js
export async function setStatus(boardPath, repo, state, opts = {}) {
  const { lastEvent = 'manual', now = () => new Date().toISOString(), ...io } = opts;
  if (!STATES.includes(state)) {
    throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  }
  const board = await readBoard(boardPath, io);
  board.repos[repo] = { status: state, updatedAt: now(), lastEvent };
  await writeBoard(boardPath, board, io);
  return board;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/board.js test/board.test.js
rtk git commit -m "feat: setStatus transition with validation"
```

---

## Task 5: `board.js` — `initRepos`

**Files:**
- Modify: `src/board.js`
- Test: `test/board.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/board.test.js
import { initRepos } from '../src/board.js';

test('initRepos adds missing repos as todo without clobbering existing ones', async () => {
  const board = await initRepos('/x', ['a', 'b'], {
    now: () => 'T',
    read: async () => JSON.stringify({ version: 1, repos: { a: { status: 'done', updatedAt: 'old', lastEvent: 'done' } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos.a, { status: 'done', updatedAt: 'old', lastEvent: 'done' });
  assert.deepEqual(board.repos.b, { status: 'todo', updatedAt: 'T', lastEvent: 'init' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/board.test.js`
Expected: FAIL — `initRepos` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/board.js
export async function initRepos(boardPath, repoNames, opts = {}) {
  const { now = () => new Date().toISOString(), ...io } = opts;
  const board = await readBoard(boardPath, io);
  for (const name of repoNames) {
    if (!board.repos[name]) {
      board.repos[name] = { status: 'todo', updatedAt: now(), lastEvent: 'init' };
    }
  }
  await writeBoard(boardPath, board, io);
  return board;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/board.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/board.js test/board.test.js
rtk git commit -m "feat: initRepos seeds todo entries"
```

---

## Task 6: `hooks.js` — `hookSettings`

**Files:**
- Create: `src/hooks.js`
- Test: `test/hooks.test.js`

The Claude Code settings shape (verified against the hooks docs): each event maps to an array of groups; each group has an optional `matcher` and a `hooks` array of `{ type: 'command', command }`. `UserPromptSubmit` and `Stop` take no matcher; `Notification` is matched to `permission_prompt|idle_prompt` (the "waiting on the human" notifications). The command is baked with the repo name, target state, board path, and `--event` so `lastEvent` is meaningful. The `command` prefix is injected (the CLI passes an absolute `node .../bin/workspace.js`).

- [ ] **Step 1: Write the failing test**

```js
// test/hooks.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookSettings } from '../src/hooks.js';

test('hookSettings maps the three events to status commands', () => {
  const s = hookSettings('example-api', '/ws/.ai-sync/board.json', { command: 'node /a/bin/workspace.js' });
  const cmd = (e) => s.hooks[e][0].hooks[0].command;
  assert.equal(s.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(cmd('UserPromptSubmit'),
    'node /a/bin/workspace.js status example-api inprogress --board /ws/.ai-sync/board.json --event UserPromptSubmit');
  assert.equal(s.hooks.Notification[0].matcher, 'permission_prompt|idle_prompt');
  assert.equal(cmd('Notification'),
    'node /a/bin/workspace.js status example-api question --board /ws/.ai-sync/board.json --event Notification');
  assert.equal(cmd('Stop'),
    'node /a/bin/workspace.js status example-api question --board /ws/.ai-sync/board.json --event Stop');
  assert.equal(s.hooks.Stop[0].hooks[0].type, 'command');
});

test('hookSettings defaults the command to ai-workspace', () => {
  const s = hookSettings('a', '/b.json');
  assert.match(s.hooks.Stop[0].hooks[0].command, /^ai-workspace status a question /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/hooks.test.js`
Expected: FAIL — `Cannot find module '../src/hooks.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/hooks.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', state: 'inprogress', matcher: undefined },
  { event: 'Notification', state: 'question', matcher: 'permission_prompt|idle_prompt' },
  { event: 'Stop', state: 'question', matcher: undefined },
];

export function hookSettings(repo, boardPath, { command = 'ai-workspace' } = {}) {
  const hooks = {};
  for (const { event, state, matcher } of HOOK_EVENTS) {
    const group = {
      hooks: [{
        type: 'command',
        command: `${command} status ${repo} ${state} --board ${boardPath} --event ${event}`,
      }],
    };
    if (matcher) group.matcher = matcher;
    hooks[event] = [group];
  }
  return { hooks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/hooks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/hooks.js test/hooks.test.js
rtk git commit -m "feat: generate Claude Code hook settings"
```

---

## Task 7: `hooks.js` — `installHooks` (merge into settings.local.json)

**Files:**
- Modify: `src/hooks.js`
- Test: `test/hooks.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/hooks.test.js
import { installHooks } from '../src/hooks.js';

test('installHooks writes a fresh settings.local.json when none exists', async () => {
  const writes = [];
  const res = await installHooks('/ws/example-api', 'example-api', '/b.json', {
    command: 'ai-workspace',
    read: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    write: async (file, data) => writes.push({ file, data }),
    ensureDir: async () => {},
  });
  assert.equal(res.file, '/ws/example-api/.claude/settings.local.json');
  assert.equal(writes.length, 1);
  assert.ok(JSON.parse(writes[0].data).hooks.Stop);
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

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/hooks.test.js`
Expected: FAIL — `installHooks` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to src/hooks.js
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/hooks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/hooks.js test/hooks.test.js
rtk git commit -m "feat: install/merge hooks into settings.local.json"
```

---

## Task 8: `workspace.js` — `status` subcommand + `main` routing

**Files:**
- Modify: `src/workspace.js` (imports at top; rename current `main` body to `runBootstrapMain`; add `runStatus` and a new `main`)
- Test: `test/workspace.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/workspace.test.js  (import setStatus name for spy injection)
test('main routes the status subcommand to setStatus', async () => {
  const calls = [];
  const code = await main(['status', 'example-api', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setStatus: async (boardPath, repo, state, o) => { calls.push({ boardPath, repo, state, o }); },
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ boardPath: path.resolve('/b.json'), repo: 'example-api', state: 'question', o: { lastEvent: 'Stop' } }]);
});

test('status subcommand requires repo and state', async () => {
  await assert.rejects(
    () => main(['status', 'example-api', '--board', '/b.json'], { setStatus: async () => {}, logger: silentLogger() }),
    /Usage: .*status <repo> <state>/,
  );
});

test('status subcommand defaults lastEvent to manual', async () => {
  let received;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setStatus: async (_p, _r, _s, o) => { received = o; }, logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'manual' });
});

test('main still routes the default (no subcommand) path to bootstrap', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config, runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(received.workspaceDir, path.resolve('/tmp/ws'));
});

test('main accepts an explicit bootstrap subcommand', async () => {
  let received;
  await main(['bootstrap', '--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config, runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(received.editor, 'claude');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workspace.test.js`
Expected: FAIL — `status` is treated as a bootstrap flag / unknown.

- [ ] **Step 3: Write minimal implementation**

In `src/workspace.js`, add imports near the top:

```js
import { setStatus as defaultSetStatus, resolveBoardPath, initRepos } from './board.js';
import { installHooks as defaultInstallHooks } from './hooks.js';
import { fileURLToPath } from 'node:url';
```

Rename the existing `export async function main(argv, deps = {})` to:

```js
async function runBootstrapMain(argv, deps = {}) {
```

(Leave its body unchanged for now — Task 9 extends it.)

Add the new router and status handler:

```js
export async function main(argv, deps = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'status') return runStatus(rest, deps);
  if (sub === 'bootstrap') return runBootstrapMain(rest, deps);
  return runBootstrapMain(argv, deps);
}

async function runStatus(argv, deps = {}) {
  const { setStatus = defaultSetStatus, logger = console } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' }, event: { type: 'string' } },
  });
  const [repo, state] = positionals;
  if (!repo || !state) throw new Error('Usage: ai-workspace status <repo> <state> [--board <path>] [--event <name>]');
  const boardPath = resolveBoardPath({ board: values.board });
  await setStatus(boardPath, repo, state, { lastEvent: values.event ?? 'manual' });
  logger.log(`${repo} → ${state}`);
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/workspace.test.js`
Expected: PASS (existing bootstrap tests still pass because the no-subcommand path delegates to `runBootstrapMain`).

- [ ] **Step 5: Commit**

```bash
rtk git add src/workspace.js test/workspace.test.js
rtk git commit -m "feat: ai-workspace status subcommand + routing"
```

---

## Task 9: `bootstrap` initializes the board and installs hooks

**Files:**
- Modify: `src/workspace.js` (`bootstrap` signature + body; `runBootstrapMain` passes `boardPath`)
- Test: `test/workspace.test.js`

- [ ] **Step 1: Write the failing test**

```js
// add to test/workspace.test.js
test('bootstrap installs hooks per repo and initializes the board (skipped on dry-run)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const installed = [];
  let inited;
  await bootstrap(config, {
    workspaceDir: ws,
    clone: async () => {},
    exec: async () => {},
    exists: async () => false,
    installRepoHooks: async (dir, repo, boardPath) => { installed.push({ dir, repo, boardPath }); },
    initBoard: async (boardPath, names) => { inited = { boardPath, names }; },
    logger: silentLogger(),
  });
  const boardPath = path.join(ws, '.ai-sync', 'board.json');
  assert.deepEqual(installed, [
    { dir: path.join(ws, 'a'), repo: 'a', boardPath },
    { dir: path.join(ws, 'b'), repo: 'b', boardPath },
  ]);
  assert.deepEqual(inited, { boardPath, names: ['a', 'b'] });
  await rm(ws, { recursive: true, force: true });
});

test('bootstrap dry-run does not install hooks or init the board', async () => {
  const installed = [];
  let inited = false;
  await bootstrap(config, {
    workspaceDir: '/tmp/ws-dry',
    dryRun: true,
    clone: async () => {}, exec: async () => {}, exists: async () => false,
    installRepoHooks: async () => { installed.push(1); },
    initBoard: async () => { inited = true; },
    logger: silentLogger(),
  });
  assert.equal(installed.length, 0);
  assert.equal(inited, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workspace.test.js`
Expected: FAIL — `bootstrap` ignores `installRepoHooks`/`initBoard`.

- [ ] **Step 3: Write minimal implementation**

In `bootstrap`'s options destructuring (around `src/workspace.js:21-33`), add:

```js
    boardPath: boardPathOption,
    installRepoHooks = defaultInstallHooks,
    initBoard = initRepos,
    hookCommand,
```

After computing `repos` and before the loop, resolve the board path and the command hooks will call:

```js
  const boardPath = boardPathOption ?? path.join(workspaceDir, '.ai-sync', 'board.json');
  const command = hookCommand ?? `node ${fileURLToPath(new URL('../bin/workspace.js', import.meta.url))}`;
```

Inside the `for (const repo of repos)` loop, after `workDirs.push(workDir);` and before the install block, add:

```js
    if (!dryRun) await installRepoHooks(workDir, repo.name, boardPath, { command });
```

After the loop, before computing `launchDir`, add:

```js
  if (!dryRun) await initBoard(boardPath, repos.map((r) => r.name));
```

Then update `runBootstrapMain` to forward nothing new (board path defaults inside `bootstrap`); no change needed there unless exposing `--board`, which is out of scope for bootstrap.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/workspace.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/workspace.js test/workspace.test.js
rtk git commit -m "feat: bootstrap installs hooks and seeds the board"
```

---

## Task 10: Full coverage gate + docs

**Files:**
- Modify: `README.md` (document `ai-workspace status` and the board.json / hooks behavior)
- Test: whole suite

- [ ] **Step 1: Run the full suite with the coverage gate**

Run: `npm test`
Expected: PASS with 100% lines/functions/branches on `src/**`. If any branch is uncovered (e.g. the `dryRun` true/false sides, the ENOENT vs other-error paths), add the matching test before continuing.

- [ ] **Step 2: Document the new behavior in `README.md`**

Add a "Status tracking" section describing: `board.json` location (`<workspace>/.ai-sync/board.json`), the four states, that `bootstrap` installs `.claude/settings.local.json` hooks per repo, and that Claude marks `done` by running:

```
node <ai-sync>/bin/workspace.js status <repo> done --board <board.json>
```

(or `ai-workspace status <repo> done` if installed on PATH).

- [ ] **Step 3: Commit**

```bash
rtk git add README.md
rtk git commit -m "docs: document workspace status tracking"
```

---

## Self-Review

- **Spec coverage:** Section 1 (board.json model) → Tasks 2–5. Section 2 (status subcommand + hook install + done) → Tasks 6–9. 100% coverage requirement → Task 10. The board server/viewer (Section 3) and front-end tests (Section 4) are the second plan.
- **Type consistency:** `setStatus(boardPath, repo, state, opts)`, `initRepos(boardPath, names, opts)`, `installHooks(checkoutDir, repo, boardPath, opts)`, `hookSettings(repo, boardPath, {command})`, `resolveBoardPath({board, env})` are used identically wherever referenced. `lastEvent` values: `init` (seed), hook event name (auto), `manual` (CLI default).
- **Placeholder scan:** none — every code step is complete.
- **Interface for plan 2:** `board.json` = `{ version: 1, repos: { <name>: { status, updatedAt, lastEvent } } }`, default `<workspace>/.ai-sync/board.json`.
