# Board Startup Hook Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every time the board server starts (with `--config`/`AI_SYNC_CONFIG` given), automatically detect and repoint drifted Claude Code hooks (stale CLI path, wrong board target) for every configured repo whose checkout already exists on disk, so the class of bug found this session (a card frozen for weeks because its hook silently crashed) gets caught and healed without manual intervention.

**Architecture:** A new `reconcileHooks(config, { boardPath, hookCommand, ... })` in `libs/workspace-bootstrap` loops over every repo, resolves its checkout (via `repo.path` or `<workspaceDir>/<name>`, where `workspaceDir` is derived from `boardPath`'s own `<workspaceDir>/.ai-sync/board.json` layout), compares its currently-installed hook commands against what `hookSettings()` would produce today, and calls the existing `installHooks()` to repoint it when they differ (or it has none yet). Per-repo failures are caught inside the loop so one bad repo can't stop the rest. `apps/board/server.js`'s `startFromArgv` becomes `async` and calls this once at startup, computing the hook command's path relative to the running script (so it can never go stale again), then logs a one-line summary.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`, `node:http` for the server), reuses existing `@ai-sync/config`/`@ai-sync/workspace-bootstrap` libraries. No new runtime dependencies.

**Reference:** Full rationale and decisions in `docs/superpowers/specs/2026-07-23-board-startup-hook-reconciliation-design.md`.

---

### Task 1: `reconcileHooks()` — `libs/workspace-bootstrap`

**Files:**
- Create: `libs/workspace-bootstrap/src/reconcile.js`
- Modify: `libs/workspace-bootstrap/src/index.js`
- Test: `libs/workspace-bootstrap/test/reconcile.test.js` (new)

- [x] **Step 1: Write the failing tests**

Create `libs/workspace-bootstrap/test/reconcile.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileHooks } from '../src/reconcile.js';

const boardPath = '/ws/.ai-sync/board.json'; // workspaceDir derives to /ws
const hookCommand = '/cli/workspace.js';

function expectedHooks(repo) {
  return {
    UserPromptSubmit: `${hookCommand} status ${repo} inprogress --board ${boardPath} --event UserPromptSubmit`,
    Notification: `${hookCommand} status ${repo} question --board ${boardPath} --event Notification`,
    Stop: `${hookCommand} status ${repo} question --board ${boardPath} --event Stop`,
  };
}

test('repo with hooks already matching current board/command -> up-to-date, no write', async () => {
  const config = { repos: [{ name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] }] };
  const installed = [];
  let inited;
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => true,
    readCurrentHooks: async () => expectedHooks('a'),
    installRepoHooks: async (...args) => { installed.push(args); },
    initBoard: async (bp, names) => { inited = { bp, names }; },
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'up-to-date', checkout: '/ext/a' }]);
  assert.deepEqual(installed, []);
  assert.deepEqual(inited, { bp: boardPath, names: ['a'] });
});

test('repo with a stale command -> repointed, installRepoHooks called with current values', async () => {
  const config = { repos: [{ name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] }] };
  const installed = [];
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => true,
    readCurrentHooks: async () => ({
      UserPromptSubmit: '/old/bin/workspace.js status a inprogress --board /old/board.json --event UserPromptSubmit',
      Notification: '/old/bin/workspace.js status a question --board /old/board.json --event Notification',
      Stop: '/old/bin/workspace.js status a question --board /old/board.json --event Stop',
    }),
    installRepoHooks: async (...args) => { installed.push(args); },
    initBoard: async () => {},
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'repointed', checkout: '/ext/a' }]);
  assert.deepEqual(installed, [['/ext/a', 'a', boardPath, { command: hookCommand }]]);
});

test('repo with no .claude/settings.local.json yet -> repointed (first install)', async () => {
  const config = { repos: [{ name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] }] };
  const installed = [];
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => true,
    readCurrentHooks: async () => null,
    installRepoHooks: async (...args) => { installed.push(args); },
    initBoard: async () => {},
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'repointed', checkout: '/ext/a' }]);
  assert.equal(installed.length, 1);
});

test('repo with an existing settings file that has no hooks key yet -> repointed', async () => {
  const config = { repos: [{ name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] }] };
  const installed = [];
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => true,
    readCurrentHooks: async () => ({ UserPromptSubmit: undefined, Notification: undefined, Stop: undefined }),
    installRepoHooks: async (...args) => { installed.push(args); },
    initBoard: async () => {},
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'repointed', checkout: '/ext/a' }]);
  assert.equal(installed.length, 1);
});

test('repo whose checkout does not exist -> skipped-missing, no read/write attempted', async () => {
  const config = { repos: [{ name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] }] };
  const reads = [];
  const installed = [];
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => false,
    readCurrentHooks: async (...args) => { reads.push(args); return null; },
    installRepoHooks: async (...args) => { installed.push(args); },
    initBoard: async () => {},
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'skipped-missing', checkout: '/ext/a' }]);
  assert.deepEqual(reads, []);
  assert.deepEqual(installed, []);
});

test('a repo whose installRepoHooks throws is recorded as an error and does not stop the rest', async () => {
  const config = {
    repos: [
      { name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] },
      { name: 'b', url: 'u', path: '/ext/b', technologies: ['t'], targets: ['claude'] },
    ],
  };
  let inited;
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => true,
    readCurrentHooks: async () => null,
    installRepoHooks: async (dir, repo) => { if (repo === 'a') throw new Error('EACCES'); },
    initBoard: async (bp, names) => { inited = { bp, names }; },
  });
  assert.deepEqual(results, [
    { repo: 'a', status: 'error', error: 'EACCES', checkout: '/ext/a' },
    { repo: 'b', status: 'repointed', checkout: '/ext/b' },
  ]);
  assert.deepEqual(inited, { bp: boardPath, names: ['a', 'b'] });
});

test('path-based and workspaceDir-derived checkouts both resolve correctly; initBoard runs regardless of statuses', async () => {
  const config = {
    repos: [
      { name: 'a', url: 'u', path: '/ext/a', technologies: ['t'], targets: ['claude'] },
      { name: 'b', url: 'u', technologies: ['t'], targets: ['claude'] }, // no path -> derived from boardPath
    ],
  };
  let inited;
  const results = await reconcileHooks(config, {
    boardPath,
    hookCommand,
    exists: async () => false,
    readCurrentHooks: async () => null,
    installRepoHooks: async () => {},
    initBoard: async (bp, names) => { inited = { bp, names }; },
  });
  assert.deepEqual(results, [
    { repo: 'a', status: 'skipped-missing', checkout: '/ext/a' },
    { repo: 'b', status: 'skipped-missing', checkout: path.join('/ws', 'b') },
  ]);
  assert.deepEqual(inited, { bp: boardPath, names: ['a', 'b'] });
});

test('default exists/readCurrentHooks/installRepoHooks work end-to-end against the real filesystem', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reconcile-'));
  const checkout = path.join(dir, 'repo');
  await mkdir(checkout, { recursive: true });
  const config = { repos: [{ name: 'a', url: 'u', path: checkout, technologies: ['t'], targets: ['claude'] }] };
  const bp = path.join(dir, '.ai-sync', 'board.json');

  const results = await reconcileHooks(config, { boardPath: bp, hookCommand, initBoard: async () => {} });
  assert.deepEqual(results, [{ repo: 'a', status: 'repointed', checkout }]);
  const settings = JSON.parse(await readFile(path.join(checkout, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(
    settings.hooks.UserPromptSubmit[0].hooks[0].command,
    `${hookCommand} status a inprogress --board ${bp} --event UserPromptSubmit`,
  );

  const results2 = await reconcileHooks(config, { boardPath: bp, hookCommand, initBoard: async () => {} });
  assert.deepEqual(results2, [{ repo: 'a', status: 'up-to-date', checkout }]);
  await rm(dir, { recursive: true, force: true });
});

test('default exists returns false for a checkout missing on the real filesystem', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reconcile-'));
  const missing = path.join(dir, 'missing');
  const config = { repos: [{ name: 'a', url: 'u', path: missing, technologies: ['t'], targets: ['claude'] }] };
  const bp = path.join(dir, '.ai-sync', 'board.json');
  const results = await reconcileHooks(config, { boardPath: bp, hookCommand, initBoard: async () => {} });
  assert.deepEqual(results, [{ repo: 'a', status: 'skipped-missing', checkout: missing }]);
  await rm(dir, { recursive: true, force: true });
});

test('a repo with a settings file that has no hooks key gets hooks installed for real, preserving other settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reconcile-'));
  const checkout = path.join(dir, 'repo');
  await mkdir(path.join(checkout, '.claude'), { recursive: true });
  await writeFile(
    path.join(checkout, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }),
  );
  const config = { repos: [{ name: 'a', url: 'u', path: checkout, technologies: ['t'], targets: ['claude'] }] };
  const bp = path.join(dir, '.ai-sync', 'board.json');
  const results = await reconcileHooks(config, { boardPath: bp, hookCommand, initBoard: async () => {} });
  assert.deepEqual(results, [{ repo: 'a', status: 'repointed', checkout }]);
  const settings = JSON.parse(await readFile(path.join(checkout, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.ok(settings.hooks.UserPromptSubmit);
  await rm(dir, { recursive: true, force: true });
});

test('default initBoard seeds the board for real when not overridden', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reconcile-'));
  const checkout = path.join(dir, 'repo');
  await mkdir(checkout, { recursive: true });
  const config = { repos: [{ name: 'a', url: 'u', path: checkout, technologies: ['t'], targets: ['claude'] }] };
  const bp = path.join(dir, '.ai-sync', 'board.json');
  await reconcileHooks(config, { boardPath: bp, hookCommand });
  const board = JSON.parse(await readFile(bp, 'utf8'));
  assert.equal(board.repos.a.status, 'todo');
  await rm(dir, { recursive: true, force: true });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace-bootstrap`
Expected: FAIL with `Cannot find module '../src/reconcile.js'` (the file doesn't exist yet).

- [x] **Step 3: Implement `reconcileHooks()`**

Create `libs/workspace-bootstrap/src/reconcile.js`:

```js
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hookSettings, installHooks } from './hooks.js';
import { initRepos } from './board.js';

const HOOK_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop'];

async function defaultExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function flattenHooks(hooks) {
  const flat = {};
  for (const event of HOOK_EVENTS) {
    flat[event] = hooks?.[event]?.[0]?.hooks?.[0]?.command;
  }
  return flat;
}

async function defaultReadCurrentHooks(checkoutDir, { read = readFile } = {}) {
  const file = path.join(checkoutDir, '.claude', 'settings.local.json');
  let parsed;
  try {
    parsed = JSON.parse(await read(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
  return flattenHooks(parsed.hooks);
}

function hooksMatch(before, expectedHooks) {
  if (!before) return false;
  const expected = flattenHooks(expectedHooks);
  return HOOK_EVENTS.every((event) => before[event] === expected[event]);
}

// Every repo whose checkout already exists gets its hooks compared against
// what hookSettings() would produce today, and repointed if they differ (or
// don't exist yet). A repo's own failure is recorded, not thrown, so one bad
// repo can't stop the rest from being checked.
export async function reconcileHooks(config, options = {}) {
  const {
    boardPath,
    hookCommand,
    exists = defaultExists,
    readCurrentHooks = defaultReadCurrentHooks,
    installRepoHooks = installHooks,
    initBoard = initRepos,
  } = options;

  const workspaceDir = path.dirname(path.dirname(boardPath));
  const results = [];

  for (const repo of config.repos) {
    const checkout = repo.path ? path.resolve(repo.path) : path.join(workspaceDir, repo.name);
    try {
      if (!(await exists(checkout))) {
        results.push({ repo: repo.name, status: 'skipped-missing', checkout });
        continue;
      }
      const before = await readCurrentHooks(checkout);
      const expected = hookSettings(repo.name, boardPath, { command: hookCommand }).hooks;
      if (hooksMatch(before, expected)) {
        results.push({ repo: repo.name, status: 'up-to-date', checkout });
        continue;
      }
      await installRepoHooks(checkout, repo.name, boardPath, { command: hookCommand });
      results.push({ repo: repo.name, status: 'repointed', checkout });
    } catch (err) {
      results.push({ repo: repo.name, status: 'error', error: err.message, checkout });
    }
  }

  await initBoard(boardPath, config.repos.map((r) => r.name));
  return results;
}
```

Then modify `libs/workspace-bootstrap/src/index.js` — current content:

```js
export { bootstrap, formatTimestamp } from './bootstrap.js';
export { resolveBoardPath, setStatus } from './board.js';
```
becomes:
```js
export { bootstrap, formatTimestamp } from './bootstrap.js';
export { resolveBoardPath, setStatus } from './board.js';
export { reconcileHooks } from './reconcile.js';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, all tests (new and pre-existing) green, 100% line/branch/function coverage gate satisfied across all 6 source files (`board.js`, `bootstrap.js`, `hooks.js`, `installers.js`, `platform.js`, `reconcile.js`).

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add libs/workspace-bootstrap/src/reconcile.js libs/workspace-bootstrap/src/index.js libs/workspace-bootstrap/test/reconcile.test.js
```

---

### Task 2: Wire `@ai-sync/config` and `@ai-sync/workspace-bootstrap` into `apps/board`

**Files:**
- Modify: `apps/board/package.json`

`apps/board` currently has no dependency on either library — `server.js` needs both in Task 3 (`loadConfig` from `@ai-sync/config`, `reconcileHooks` from `@ai-sync/workspace-bootstrap`).

- [x] **Step 1: Add the two workspace dependencies**

In `apps/board/package.json`, current `dependencies`:

```json
"dependencies": {
  "vue": "^3.5.0"
}
```
becomes:
```json
"dependencies": {
  "@ai-sync/config": "*",
  "@ai-sync/workspace-bootstrap": "*",
  "vue": "^3.5.0"
}
```

(This matches the exact pattern already used by `apps/workspace/package.json` for the same two libraries.)

- [x] **Step 2: Install so the workspace symlinks are created**

Run: `npm install`
Expected: completes without error; `apps/board/node_modules/@ai-sync/config` and `apps/board/node_modules/@ai-sync/workspace-bootstrap` exist as symlinks into `libs/config` and `libs/workspace-bootstrap`.

Verify:
```bash
ls -la apps/board/node_modules/@ai-sync/config apps/board/node_modules/@ai-sync/workspace-bootstrap
```
Expected: both are symlinks (`->`) pointing into `../../../libs/config` / `../../../libs/workspace-bootstrap`.

- [ ] **Step 3: Stage (do NOT commit)**

```bash
git add apps/board/package.json package-lock.json
```

---

### Task 3: `apps/board/server.js` — reconcile on startup

**Files:**
- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [x] **Step 1: Write the failing tests**

Append to `apps/board/server.test.js` (uses the already-imported `mkdtemp`, `writeFile`, `rm`, `tmpdir`, `path`, `startFromArgv`, and the file's existing `listening` helper; add `readFile` and `mkdir` to the existing `node:fs/promises` import):

Change the existing import line:
```js
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
```
to:
```js
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
```

Then append these tests:

```js
test('startFromArgv reconciles a repo\'s hooks on start and logs what changed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const checkout = path.join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  const boardPath = path.join(dir, '.ai-sync', 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({
    repos: [{ name: 'demo', url: 'https://h/demo.git', path: checkout, technologies: ['nestjs'], targets: ['claude'] }],
  }));
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(logs.some((m) => m.includes('✓ demo: hooks repointed')));
  const settings = JSON.parse(await readFile(path.join(checkout, '.claude', 'settings.local.json'), 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /status demo inprogress --board/);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv logs "all up to date" on a second start once hooks are already correct', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const checkout = path.join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  const boardPath = path.join(dir, '.ai-sync', 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({
    repos: [{ name: 'demo', url: 'https://h/demo.git', path: checkout, technologies: ['nestjs'], targets: ['claude'] }],
  }));
  const firstServer = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: () => {} },
  );
  await listening(firstServer);
  firstServer.close();

  const logs = [];
  const secondServer = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(secondServer);
  assert.ok(logs.some((m) => m.includes('hooks verified for 1 repo(s), all up to date')));
  secondServer.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv performs no hook reconciliation when --config is not given', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(!logs.some((m) => m.includes('hooks')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv logs a warning and still starts when the config file is invalid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, '{not json');
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(logs.some((m) => m.includes('⚠ hook reconciliation skipped')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

Then update the one pre-existing test whose contract changes because `startFromArgv` becomes `async` (it currently calls it without `await`):

Current:
```js
test('startFromArgv falls back to the next port when the chosen one is busy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const blocker = createServer((_req, res) => res.end());
  // Bind on all interfaces (no host) so it conflicts with startFromArgv's default bind.
  const busyPort = await new Promise((resolve) => blocker.listen(0, () => resolve(blocker.address().port)));
  const logs = [];
  const server = startFromArgv(
    ['--board', path.join(dir, 'board.json'), '--port', String(busyPort), '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  const boundPort = await listening(server);
```
becomes (only the `server = startFromArgv(...)` line changes, to `await`):
```js
test('startFromArgv falls back to the next port when the chosen one is busy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const blocker = createServer((_req, res) => res.end());
  // Bind on all interfaces (no host) so it conflicts with startFromArgv's default bind.
  const busyPort = await new Promise((resolve) => blocker.listen(0, () => resolve(blocker.address().port)));
  const logs = [];
  const server = await startFromArgv(
    ['--board', path.join(dir, 'board.json'), '--port', String(busyPort), '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  const boundPort = await listening(server);
```

- [x] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx nx run board:test-server`
Expected: the 4 new tests FAIL (`reconcileHooks`/`loadConfig` aren't wired into `startFromArgv` yet, so no hook file gets written and no matching log lines appear); the port-fallback test also FAILs in a way that shows `server.listen is not a function` or similar (since `startFromArgv` currently returns a bare `Server` synchronously — until Step 3, awaiting it just resolves to that same object today, so this particular test might still incidentally pass; if it does, that's fine, the assertion is about behavior after Step 3 making the function genuinely async).

- [x] **Step 3: Implement the server integration**

In `apps/board/server.js`, add two imports (after the existing `fileURLToPath` import):

```js
import { loadConfig } from '@ai-sync/config';
import { reconcileHooks } from '@ai-sync/workspace-bootstrap';
```

Then change `export function startFromArgv(argv, { log = console.log } = {}) {` to `export async function startFromArgv(argv, { log = console.log } = {}) {`.

Insert this block right after the existing `const configPath = configSrc ? path.resolve(configSrc) : null;` line and before `const distDir = ...`:

```js
  if (configPath) {
    try {
      const config = await loadConfig(configPath);
      const hookCommand = fileURLToPath(new URL('../workspace/bin/workspace.js', import.meta.url));
      const results = await reconcileHooks(config, { boardPath, hookCommand });
      for (const r of results) {
        if (r.status === 'repointed') log(`  ✓ ${r.repo}: hooks repointed`);
        else if (r.status === 'error') log(`  ⚠ ${r.repo}: ${r.error}`);
      }
      if (!results.some((r) => r.status === 'repointed' || r.status === 'error')) {
        log(`  hooks verified for ${results.length} repo(s), all up to date`);
      }
    } catch (err) {
      log(`  ⚠ hook reconciliation skipped: ${err.message}`);
    }
  }
```

Finally, at the bottom of the file, change:
```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startFromArgv(process.argv.slice(2));
}
```
to:
```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startFromArgv(process.argv.slice(2));
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx nx run board:test-server`
Expected: PASS, all tests (new and pre-existing) green.

Also run the front-end suite to confirm nothing else broke:
Run: `npx nx run board:test`
Expected: PASS.

Note: this repo's `apps/board` front-end suite (`App.test.js`) has two known pre-existing failures unrelated to any of this plan's work (a stale notification-count assertion and a missing detail-panel button), confirmed present before this feature was started. If `npx nx run board:test` surfaces them, that's expected — don't attempt to fix them as part of this plan.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add apps/board/server.js apps/board/server.test.js
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (`reconcileHooks`) → Task 1, including every listed test scenario (up-to-date, stale, first-install, no-hooks-key, missing-checkout, per-repo error isolation, `path`-vs-derived checkout resolution, `initBoard` always called). Section 2 (`server.js` integration) → Task 3, matching the exact log-line contract from the design (including the pre-existing port-fallback test's now-required `await`). One dependency-wiring gap the design didn't spell out (Section 2's imports assume `@ai-sync/config`/`@ai-sync/workspace-bootstrap` are reachable from `apps/board`, but nothing declared that dependency) is covered by the added Task 2.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `reconcileHooks(config, { boardPath, hookCommand, exists, readCurrentHooks, installRepoHooks, initBoard })` — the option names and the four-field result shape (`{ repo, status, checkout, error? }`) are used identically across Task 1's implementation, Task 1's tests, and Task 3's server integration. `status` values (`'up-to-date' | 'repointed' | 'skipped-missing' | 'error'`) match exactly everywhere they're checked.
- **Deviation from the approved design, noted here rather than re-opening brainstorming:** the design's Section 1 pseudocode included an unused `logger = console` option on `reconcileHooks`. Since the function never actually logs anything itself — Section 2 already does all the logging, based on the returned `results` array — that parameter is dropped from the real implementation as dead code (YAGNI). Nothing in Section 2 or the tests depended on `reconcileHooks` logging internally, so this doesn't change any observable behavior.
