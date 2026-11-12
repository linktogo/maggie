# Local offline-friendly install cache (Node + Maven) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace-bootstrap installs cache-first (Node `pnpm` and a new Maven step), with a soft `--prefer-offline` default and a strict `--offline` flag, reusing each tool's existing global cache.

**Architecture:** A new declarative installer registry (`src/installers.js`) exposes `planInstall(workDir, opts)` that returns the install command for the first matching marker file (`package.json` → pnpm, `pom.xml` → maven). `bootstrap` replaces its hard-coded pnpm branch with a `planInstall` call. Maven binary resolution (wrapper-aware, OS-aware) lives in `src/platform.js`. A `--offline` CLI flag threads through `main` → `bootstrap` → `planInstall`.

**Tech Stack:** Node.js (ESM, `node:test`), `node --test` with a 100% coverage gate on `src/**` (`npm test`).

---

## File Structure

- `src/platform.js` — **Modify**: add `mavenCommand(workDir, { exists, platform })`. Already owns OS-aware command resolution (`pnpmCommand`, `launchCommand`).
- `src/installers.js` — **Create**: `INSTALLERS` registry + `planInstall(...)`. Single responsibility: "what to install and how", isolated from cloning/worktree logic.
- `src/workspace.js` — **Modify**: `bootstrap` install branch (`:106-111`) → `planInstall`; add `offline` option; `main` adds `--offline` flag and forwards it.
- `test/platform.test.js` — **Modify**: add `mavenCommand` tests.
- `test/installers.test.js` — **Create**: `planInstall` tests.
- `test/workspace.test.js` — **Modify**: update two exec-arg assertions; add offline / maven / no-marker tests; assert `--offline` forwarding.
- `README.md` — **Modify**: document the Maven step and `--offline`.

**Coverage note:** Every task must keep `npm test` at 100% lines/branches/functions on `src/`. Per-task steps run a single test file with `node --test`; the final task runs the full gate.

---

### Task 1: `mavenCommand` — wrapper-aware, OS-aware Maven binary

**Files:**
- Modify: `src/platform.js`
- Test: `test/platform.test.js`

- [ ] **Step 1: Write the failing tests**

Add to the top of `test/platform.test.js`, changing the import line and appending the tests:

```js
import path from 'node:path';
import { pnpmCommand, launchCommand, mavenCommand } from '../src/platform.js';
```

Append at the end of the file:

```js
test('mavenCommand prefers the repo wrapper when present (POSIX)', async () => {
  const wrapper = path.join('/work/app', 'mvnw');
  const cmd = await mavenCommand('/work/app', {
    exists: async (p) => p === wrapper,
    platform: 'linux',
  });
  assert.equal(cmd, wrapper);
});

test('mavenCommand prefers the .cmd wrapper on Windows', async () => {
  const wrapper = path.join('/work/app', 'mvnw.cmd');
  const cmd = await mavenCommand('/work/app', {
    exists: async (p) => p === wrapper,
    platform: 'win32',
  });
  assert.equal(cmd, wrapper);
});

test('mavenCommand falls back to system mvn on POSIX', async () => {
  const cmd = await mavenCommand('/work/app', { exists: async () => false, platform: 'linux' });
  assert.equal(cmd, 'mvn');
});

test('mavenCommand falls back to mvn.cmd on Windows', async () => {
  const cmd = await mavenCommand('/work/app', { exists: async () => false, platform: 'win32' });
  assert.equal(cmd, 'mvn.cmd');
});

test('mavenCommand defaults to the current platform', async () => {
  const expected = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
  const cmd = await mavenCommand('/work/app', { exists: async () => false });
  assert.equal(cmd, expected);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/platform.test.js`
Expected: FAIL — `mavenCommand is not a function` (or `undefined`).

- [ ] **Step 3: Implement `mavenCommand`**

In `src/platform.js`, add `import path from 'node:path';` as the first line, then append this function at the end:

```js
// Resolve the Maven binary. Prefer the repo's wrapper (mvnw / mvnw.cmd) for a
// pinned, reproducible Maven version; otherwise use the system mvn. On Windows
// the `.cmd` shims are used, consistent with pnpmCommand.
export async function mavenCommand(workDir, { exists, platform = process.platform }) {
  const wrapperName = platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const wrapper = path.join(workDir, wrapperName);
  if (await exists(wrapper)) return wrapper;
  return platform === 'win32' ? 'mvn.cmd' : 'mvn';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/platform.test.js`
Expected: PASS (all platform tests green).

- [ ] **Step 5: Commit**

```bash
git add src/platform.js test/platform.test.js
git commit -m "feat: add wrapper-aware mavenCommand resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `installers.js` — registry + `planInstall`

**Files:**
- Create: `src/installers.js`
- Test: `test/installers.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/installers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planInstall } from '../src/installers.js';

const onlyMarker = (workDir, marker) => async (p) => p === path.join(workDir, marker);

test('node project resolves to pnpm install --prefer-offline by default', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'package.json'),
    platform: 'linux',
  });
  assert.deepEqual(plan, {
    name: 'node', label: 'pnpm', command: 'pnpm', args: ['install', '--prefer-offline'],
  });
});

test('node project uses --offline in strict mode', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'package.json'),
    platform: 'linux',
    offline: true,
  });
  assert.deepEqual(plan.args, ['install', '--offline']);
});

test('maven project resolves to dependency:go-offline with the system mvn', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'pom.xml'),
    platform: 'linux',
  });
  assert.deepEqual(plan, {
    name: 'maven', label: 'mvn', command: 'mvn', args: ['dependency:go-offline'],
  });
});

test('maven project uses -o in strict offline mode', async () => {
  const plan = await planInstall('/w/app', {
    exists: onlyMarker('/w/app', 'pom.xml'),
    platform: 'linux',
    offline: true,
  });
  assert.deepEqual(plan.args, ['-o', 'dependency:go-offline']);
});

test('maven project prefers the repo wrapper when present', async () => {
  const wrapper = path.join('/w/app', 'mvnw');
  const exists = async (p) => p === path.join('/w/app', 'pom.xml') || p === wrapper;
  const plan = await planInstall('/w/app', { exists, platform: 'linux' });
  assert.equal(plan.command, wrapper);
});

test('no recognised marker yields null', async () => {
  const plan = await planInstall('/w/app', { exists: async () => false, platform: 'linux' });
  assert.equal(plan, null);
});

test('platform and offline default when omitted', async () => {
  const plan = await planInstall('/w/app', { exists: onlyMarker('/w/app', 'package.json') });
  const expectedPnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  assert.equal(plan.command, expectedPnpm);
  assert.deepEqual(plan.args, ['install', '--prefer-offline']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/installers.test.js`
Expected: FAIL — cannot find module `../src/installers.js`.

- [ ] **Step 3: Implement the registry**

Create `src/installers.js`:

```js
import path from 'node:path';
import { pnpmCommand, mavenCommand } from './platform.js';

// Declarative registry: one entry per ecosystem. The first installer whose
// marker file is present in the work directory wins.
const INSTALLERS = [
  {
    name: 'node',
    marker: 'package.json',
    label: 'pnpm',
    resolve: (workDir, { platform, offline }) => ({
      command: pnpmCommand(platform),
      args: ['install', offline ? '--offline' : '--prefer-offline'],
    }),
  },
  {
    name: 'maven',
    marker: 'pom.xml',
    label: 'mvn',
    resolve: async (workDir, { exists, platform, offline }) => ({
      command: await mavenCommand(workDir, { exists, platform }),
      args: offline ? ['-o', 'dependency:go-offline'] : ['dependency:go-offline'],
    }),
  },
];

// Returns { name, label, command, args } for the matching ecosystem, or null
// when the work directory has no recognised marker file.
export async function planInstall(workDir, { exists, platform = process.platform, offline = false }) {
  for (const inst of INSTALLERS) {
    if (await exists(path.join(workDir, inst.marker))) {
      const { command, args } = await inst.resolve(workDir, { exists, platform, offline });
      return { name: inst.name, label: inst.label, command, args };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/installers.test.js`
Expected: PASS (7 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/installers.js test/installers.test.js
git commit -m "feat: add installer registry with planInstall (pnpm + maven)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire `bootstrap` to `planInstall` + `offline` option

**Files:**
- Modify: `src/workspace.js:6` (import), `:30-45` (destructure), `:106-111` (install branch)
- Test: `test/workspace.test.js`

- [ ] **Step 1: Update existing exec-arg assertions (they will now include the offline flag)**

In `test/workspace.test.js`, in the test **'clones missing repos, reuses present ones, and installs when package.json exists'**, change:

```js
  assert.deepEqual(execCalls, [{ file: 'pnpm', args: ['install'], opts: { cwd: path.join(ws, 'a') } }]);
```

to:

```js
  assert.deepEqual(execCalls, [{ file: 'pnpm', args: ['install', '--prefer-offline'], opts: { cwd: path.join(ws, 'a') } }]);
```

In the test **'claude + --worktree adds a worktree, installs in it, and launches there'**, change:

```js
    { file: 'pnpm', args: ['install'], opts: { cwd: wt } },
```

to:

```js
    { file: 'pnpm', args: ['install', '--prefer-offline'], opts: { cwd: wt } },
```

- [ ] **Step 2: Add new failing tests**

Append these three tests to `test/workspace.test.js` (before the `main requires --config` test):

```js
test('offline mode installs with --offline and logs it', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const logs = [];
  await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    offline: true,
    clone: async () => {},
    exec: async (file, args) => { execCalls.push({ file, args }); },
    exists: async (p) => p === path.join(ws, 'a', 'package.json'),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });

  assert.deepEqual(execCalls, [{ file: 'pnpm', args: ['install', '--offline'] }]);
  assert.ok(logs.some((m) => m.includes('ran pnpm install (offline)')));
  await rm(ws, { recursive: true, force: true });
});

test('a Maven project runs dependency:go-offline', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    clone: async () => {},
    exec: async (file, args) => { execCalls.push({ file, args }); },
    exists: async (p) => p === path.join(ws, 'a', 'pom.xml'),
    logger: silentLogger(),
  });

  assert.deepEqual(execCalls, [{ file: 'mvn', args: ['dependency:go-offline'] }]);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'cloned', installed: true }]);
  await rm(ws, { recursive: true, force: true });
});

test('a repo with no recognised marker file is not installed', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    clone: async () => {},
    exec: async (...c) => { execCalls.push(c); },
    exists: async () => false,
    logger: silentLogger(),
  });

  assert.equal(execCalls.length, 0);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'cloned', installed: false }]);
  await rm(ws, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `node --test test/workspace.test.js`
Expected: FAIL — `offline` is ignored (still `['install']`), Maven not handled, etc.

- [ ] **Step 4: Implement the wiring in `src/workspace.js`**

Change the import on line 6 from:

```js
import { pnpmCommand, EDITORS, launchCommand } from './platform.js';
```

to:

```js
import { EDITORS, launchCommand } from './platform.js';
import { planInstall } from './installers.js';
```

In the `bootstrap` options destructure (around line 36-44), add `offline` after `dryRun`:

```js
    install = true,
    dryRun = false,
    offline = false,
    clone = defaultClone,
```

Replace the install branch (lines 106-111):

```js
    let installed = false;
    if (install && (await exists(path.join(workDir, 'package.json')))) {
      if (!dryRun) await exec(pnpmCommand(), ['install'], { cwd: workDir });
      logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would pnpm install' : 'pnpm install done'}`);
      installed = true;
    }
```

with:

```js
    let installed = false;
    if (install) {
      const plan = await planInstall(workDir, { exists, offline });
      if (plan) {
        if (!dryRun) await exec(plan.command, plan.args, { cwd: workDir });
        logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would' : 'ran'} ${plan.label} install${offline ? ' (offline)' : ''}`);
        installed = true;
      }
    }
```

- [ ] **Step 5: Run to verify all workspace tests pass**

Run: `node --test test/workspace.test.js`
Expected: PASS (existing + 3 new tests green).

- [ ] **Step 6: Commit**

```bash
git add src/workspace.js test/workspace.test.js
git commit -m "feat: bootstrap installs via planInstall with offline option

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `--offline` CLI flag in `main`

**Files:**
- Modify: `src/workspace.js:140-151` (parseArgs), `:165-174` (forward)
- Test: `test/workspace.test.js`

- [ ] **Step 1: Update the forwarding tests**

In `test/workspace.test.js`, in the test **'main loads config, resolves the workspace path, and forwards flags'**, add `'--offline'` to the argv array and assert it forwards. Change the argv line:

```js
    ['--config', 'repos.json', '--workspace', 'ws', '--editor', 'vscode', '--repo', 'a', '--worktree', 'feat/z', '--no-install', '--dry-run'],
```

to:

```js
    ['--config', 'repos.json', '--workspace', 'ws', '--editor', 'vscode', '--repo', 'a', '--worktree', 'feat/z', '--no-install', '--dry-run', '--offline'],
```

and add this assertion after `assert.equal(received.dryRun, true);`:

```js
  assert.equal(received.offline, true);
```

In the test **'main defaults editor to claude and install to true'**, add after `assert.equal(received.dryRun, false);`:

```js
  assert.equal(received.offline, false);
```

- [ ] **Step 2: Run to verify the assertions fail**

Run: `node --test test/workspace.test.js`
Expected: FAIL — `received.offline` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Implement the flag in `src/workspace.js`**

In the `parseArgs` options object, add `offline` after `'dry-run'`:

```js
      'no-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
    },
```

In the `runBootstrap(config, { … })` call, add `offline` after `dryRun`:

```js
    install: !values['no-install'],
    dryRun: values['dry-run'],
    offline: values.offline,
    onExisting: isInteractive ? onExisting : undefined,
```

- [ ] **Step 4: Run to verify tests pass**

Run: `node --test test/workspace.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.js test/workspace.test.js
git commit -m "feat: add --offline flag to workspace bootstrap CLI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Docs + full coverage gate

**Files:**
- Modify: `README.md` (Workspace bootstrap section)

- [ ] **Step 1: Update the README**

In `README.md`, in the "Workspace bootstrap" section, replace the intro sentence:

```markdown
Clone the repos from `repos.json` into a workspace folder, install Node deps with
`pnpm`, and print the command to open the workspace in Claude Code or VS Code.
```

with:

```markdown
Clone the repos from `repos.json` into a workspace folder, install dependencies
(Node via `pnpm`, Java via `mvn dependency:go-offline`, detected from
`package.json` / `pom.xml`), and print the command to open the workspace in
Claude Code or VS Code. Installs are cache-first (`pnpm --prefer-offline`;
Maven resolves `~/.m2` first) so a slow network stays off the critical path.
```

Add this line to the command list in the same section (after the `--no-install` line):

```markdown
node bin/workspace.js --config repos.json --workspace ~/work/myorg --offline      # strict offline: fail if a dep is not already cached
```

- [ ] **Step 2: Run the full suite with the coverage gate**

Run: `npm test`
Expected: PASS — all tests green, and the coverage report shows `src` at 100.00% for line/branch/funcs (including `installers.js` and `platform.js`).

- [ ] **Step 3: If coverage is below 100%, fix it**

If any `src/` file is under 100%, read the "uncovered lines" column in the coverage report and add a targeted test for that branch (e.g. an installer/offline combination not yet exercised). Re-run `npm test` until green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document Maven install step and --offline flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- Cache-first pnpm (`--prefer-offline`) → Task 2 (registry) + Task 3 (wiring). ✓
- Maven step `dependency:go-offline` → Task 1 (`mavenCommand`) + Task 2. ✓
- Strict `--offline` (pnpm `--offline`, mvn `-o`) → Task 2 + Task 4 (flag). ✓
- Reuse global caches, no server, no warm command → nothing to build; documented in Task 5 README. ✓
- Installer registry structure (Approach A) → Task 2. ✓
- Wrapper preference `./mvnw` → Task 1. ✓
- First-match-wins for dual-marker repos → encoded by registry order (node before maven) in Task 2. ✓
- Known limitation (go-offline not 100%) → spec only; no code. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**3. Type consistency:** `planInstall` returns `{ name, label, command, args }` everywhere (Task 2 definition, Task 3 usage). `mavenCommand(workDir, { exists, platform })` signature matches its caller in `installers.js`. `offline` is a boolean from `parseArgs` through `bootstrap` to `planInstall`. ✓
