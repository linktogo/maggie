# Nx Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the `ai-sync` repo into an Nx workspace (`apps/*`, `libs/*`) with npm workspaces, zero Nx Cloud, and no functional/CLI-visible change.

**Architecture:** Five hand-authored plain-ESM Nx libs (`git`, `renderers`, `config`, `skill-sync`, `workspace-bootstrap`) consumed by two hand-authored CLI apps (`sync`, `workspace`) via npm-workspace bare-specifier imports (`@ai-sync/<lib>`), plus a Vue dashboard app (`board`) regenerated with the `@nx/vue` generator. Module boundaries enforced via Nx project tags + `@nx/enforce-module-boundaries`.

**Tech Stack:** Nx 23.1.0, npm workspaces, `@nx/eslint` (inferred lint targets), `@nx/eslint-plugin` (boundaries), `@nx/vue` (board app), native `node --test` (unchanged 100%-coverage gate, now per-project).

**Spec refinement note:** The approved spec ([docs/superpowers/specs/2026-07-21-nx-migration-design.md](../specs/2026-07-21-nx-migration-design.md)) described 4 libs with `config` as generically "shared." Reading the actual code (`src/config.js` imports `knownTargets` from `src/renderers/index.js`) showed `config` genuinely depends on the renderer registry, which the spec's `libs/skill-sync` bucket would have owned — that's a boundary violation if left as specified. Fix: renderers/frontmatter become their own **5th lib, `libs/renderers`** (scope:shared, since both `config` and `skill-sync` need it), and `config` stays scope:shared on top of it. This preserves the spec's intent (git + config = shared foundation; skill-sync only for sync; workspace-bootstrap only for workspace) with an accurate dependency graph. No other decision from the spec changes.

**Verified against real tooling, not docs alone:** every generator command and its output below was actually run in a throwaway sandbox (`nx@23.1.0`, `@nx/js@23.1.0`, `@nx/vue@23.1.0`) before being written into this plan. Two concrete findings that shape the tasks:
- `@nx/js:library` (even with `--js=true --skipTsConfig=true`) still creates `tsconfig.base.json`/`tsconfig.json`/per-lib `tsconfig.*.json`, `typescript-eslint`, `prettier`, `@types/node`, `tslib` — TypeScript tooling this plain-ESM repo doesn't want. **Libs and CLI apps are hand-authored instead** (verified working: project recognition, cross-lib bare-specifier imports via npm workspace symlinks, custom `node --test` target with the existing coverage flags, inferred `@nx/eslint/plugin` lint target, and `@nx/enforce-module-boundaries` actually rejecting a disallowed cross-scope import).
- `@nx/vue:application --js=true` generates `apps/board/index.html` still pointing at `/src/main.ts` (not `.js`) — **`nx run board:build` fails out of the box** until that's fixed. There is no `@nx/vue:setup-tailwind` generator in this Nx version (it doesn't exist in `@nx/vue@23.1.0`'s generator list) — Tailwind/PostCSS config is ported from the existing `apps/board` files, not generated.

---

### Task 1: Root Nx bootstrap

**Files:**
- Modify: `package.json`
- Create: `nx.json`
- Create: `.gitignore` (append)

- [ ] **Step 1: Install Nx and the plugins this migration needs**

Run:
```bash
npm install -D nx@23.1.0 @nx/eslint@23.1.0 @nx/eslint-plugin@23.1.0 @nx/vue@23.1.0
```

- [ ] **Step 2: Create `nx.json`**

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "targetDefaults": {
    "test": { "cache": true },
    "lint": { "cache": true },
    "build": { "cache": true, "dependsOn": ["^build"] }
  },
  "plugins": [
    { "plugin": "@nx/eslint/plugin", "options": { "targetName": "lint" } }
  ]
}
```

- [ ] **Step 3: Add npm workspaces to `package.json`**

Add a `"workspaces"` field (after `"private": true`):

```json
  "workspaces": [
    "apps/*",
    "libs/*"
  ],
```

- [ ] **Step 4: Ignore Nx's local cache**

Append to `.gitignore`:
```
.nx/cache
.nx/workspace-data
```

- [ ] **Step 5: Verify**

Run: `npx nx --version` — expect `Local: v23.1.0`.
Run: `npx nx show projects` — expect `[]` (no projects yet).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json nx.json .gitignore
git commit -m "chore(nx): bootstrap Nx workspace"
```

---

### Task 2: `libs/git`

**Files:**
- Create: `libs/git/package.json`, `libs/git/project.json`, `libs/git/src/git.js`, `libs/git/test/git.test.js`
- Delete: `src/git.js`, `test/git.test.js`

- [ ] **Step 1: Move the source and test**

```bash
mkdir -p libs/git/src libs/git/test
git mv src/git.js libs/git/src/git.js
git mv test/git.test.js libs/git/test/git.test.js
```

`git.js` has no internal imports (only `node:child_process`, `node:util`) — no import edits needed. `git.test.js` imports `../src/git.js`, which still resolves correctly at its new relative depth — no edit needed.

- [ ] **Step 2: Create `libs/git/package.json`**

```json
{
  "name": "@ai-sync/git",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/git.js"
}
```

- [ ] **Step 3: Create `libs/git/project.json`**

```json
{
  "name": "git",
  "sourceRoot": "libs/git/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/git/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 libs/git/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 4: Install workspace links and verify**

```bash
npm install
npx nx run git:test
```
Expected: tests pass, coverage report shows 100% for `libs/git/src/git.js`.

- [ ] **Step 5: Commit**

```bash
git add libs/git package.json package-lock.json
git commit -m "chore(nx): extract libs/git"
```

---

### Task 3: `libs/renderers`

**Files:**
- Create: `libs/renderers/package.json`, `libs/renderers/project.json`
- Create: `libs/renderers/src/frontmatter.js`, `libs/renderers/src/renderers/{claude,copilot,cursor,windsurf,index}.js`
- Create: `libs/renderers/test/frontmatter.test.js`, `libs/renderers/test/renderers/{claude,copilot,cursor,windsurf,index}.test.js`
- Delete: `src/frontmatter.js`, `src/renderers/**`, `test/frontmatter.test.js`, `test/renderers/**`

- [ ] **Step 1: Move source and tests (structure preserved as-is)**

```bash
mkdir -p libs/renderers/src libs/renderers/test
git mv src/frontmatter.js libs/renderers/src/frontmatter.js
git mv src/renderers libs/renderers/src/renderers
git mv test/frontmatter.test.js libs/renderers/test/frontmatter.test.js
git mv test/renderers libs/renderers/test/renderers
```

No import edits: `renderers/{claude,copilot,windsurf}.js` import `../frontmatter.js` (unchanged relative position), `renderers/index.js` imports `./claude.js` etc. (unchanged), and every moved test imports its sibling `../../src/...` or `../src/...` at an unchanged relative depth.

- [ ] **Step 2: Create `libs/renderers/package.json`**

```json
{
  "name": "@ai-sync/renderers",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/renderers/index.js"
}
```

- [ ] **Step 3: Create `libs/renderers/project.json`**

```json
{
  "name": "renderers",
  "sourceRoot": "libs/renderers/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/renderers/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 libs/renderers/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 4: Verify**

```bash
npm install
npx nx run renderers:test
```
Expected: all frontmatter + renderer tests pass, 100% coverage.

- [ ] **Step 5: Commit**

```bash
git add libs/renderers package.json package-lock.json
git commit -m "chore(nx): extract libs/renderers"
```

---

### Task 4: `libs/config`

**Files:**
- Create: `libs/config/package.json`, `libs/config/project.json`, `libs/config/src/config.js`, `libs/config/test/config.test.js`
- Delete: `src/config.js`, `test/config.test.js`

- [ ] **Step 1: Move source and test**

```bash
mkdir -p libs/config/src libs/config/test
git mv src/config.js libs/config/src/config.js
git mv test/config.test.js libs/config/test/config.test.js
```

- [ ] **Step 2: Fix the cross-lib import**

In `libs/config/src/config.js`, change:
```js
import { knownTargets } from './renderers/index.js';
```
to:
```js
import { knownTargets } from '@ai-sync/renderers';
```

`config.test.js` imports only `../src/config.js` — no edit needed.

- [ ] **Step 3: Create `libs/config/package.json`**

```json
{
  "name": "@ai-sync/config",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/config.js",
  "dependencies": {
    "@ai-sync/renderers": "*"
  }
}
```

- [ ] **Step 4: Create `libs/config/project.json`**

```json
{
  "name": "config",
  "sourceRoot": "libs/config/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/config/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 libs/config/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 5: Verify**

```bash
npm install
npx nx run config:test
```
Expected: pass, 100% coverage. `npm install` must have symlinked `node_modules/@ai-sync/renderers -> ../../libs/renderers` — confirm with `ls -la node_modules/@ai-sync`.

- [ ] **Step 6: Commit**

```bash
git add libs/config package.json package-lock.json
git commit -m "chore(nx): extract libs/config"
```

---

### Task 5: `libs/skill-sync`

**Files:**
- Create: `libs/skill-sync/package.json`, `libs/skill-sync/project.json`
- Create: `libs/skill-sync/src/{pipeline,skill,skills}.js`
- Create: `libs/skill-sync/test/{pipeline,skill,skills}.test.js`, `libs/skill-sync/test/fixtures/skills/**`
- Delete: `src/{pipeline,skill,skills}.js`, `test/{pipeline,skill,skills}.test.js`, `test/fixtures/**`

- [ ] **Step 1: Move source, tests, and fixtures**

```bash
mkdir -p libs/skill-sync/src libs/skill-sync/test
git mv src/pipeline.js libs/skill-sync/src/pipeline.js
git mv src/skill.js libs/skill-sync/src/skill.js
git mv src/skills.js libs/skill-sync/src/skills.js
git mv test/pipeline.test.js libs/skill-sync/test/pipeline.test.js
git mv test/skill.test.js libs/skill-sync/test/skill.test.js
git mv test/skills.test.js libs/skill-sync/test/skills.test.js
git mv test/fixtures libs/skill-sync/test/fixtures
```

- [ ] **Step 2: Fix `pipeline.js`'s cross-lib imports**

In `libs/skill-sync/src/pipeline.js`, change:
```js
import { clone as defaultClone } from './git.js';
```
to:
```js
import { clone as defaultClone } from '@ai-sync/git';
```
and change:
```js
import { getRenderer as defaultGetRenderer } from './renderers/index.js';
```
to:
```js
import { getRenderer as defaultGetRenderer } from '@ai-sync/renderers';
```
(`import { resolveSkills as defaultResolveSkills } from './skills.js';` stays unchanged — same lib.)

`skill.js` (imports only `gray-matter`), `skills.js` (imports only `./skill.js`), and all three test files (import only their own sibling `../src/*.js`) need no further edits. `skills.test.js` locates fixtures via `path.dirname(fileURLToPath(import.meta.url))` + `'fixtures/skills'`, which still resolves correctly since `test/fixtures/skills` moved together with `test/skills.test.js`.

- [ ] **Step 3: Create `libs/skill-sync/package.json`**

```json
{
  "name": "@ai-sync/skill-sync",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/pipeline.js",
  "dependencies": {
    "@ai-sync/git": "*",
    "@ai-sync/renderers": "*",
    "gray-matter": "^4.0.3"
  }
}
```

- [ ] **Step 4: Create `libs/skill-sync/project.json`**

```json
{
  "name": "skill-sync",
  "sourceRoot": "libs/skill-sync/src",
  "projectType": "library",
  "tags": ["scope:sync", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/skill-sync/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 libs/skill-sync/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 5: Remove `gray-matter` from the root `package.json`'s `dependencies`** (it now lives in `libs/skill-sync/package.json`).

- [ ] **Step 6: Verify**

```bash
npm install
npx nx run skill-sync:test
```
Expected: pass, 100% coverage.

- [ ] **Step 7: Commit**

```bash
git add libs/skill-sync package.json package-lock.json
git commit -m "chore(nx): extract libs/skill-sync"
```

---

### Task 6: `libs/workspace-bootstrap`

This is the one lib requiring a real code split, not just a move: `src/workspace.js` currently mixes the reusable `bootstrap()` logic with CLI-only argv parsing (`main`, `runStatus`, `runBootstrapMain`). The CLI parts move to `apps/workspace` in Task 8; this task extracts just `bootstrap()` + `formatTimestamp()` into a new `bootstrap.js`, alongside the untouched `platform.js`, `installers.js`, `board.js`, `hooks.js`.

**Files:**
- Create: `libs/workspace-bootstrap/package.json`, `libs/workspace-bootstrap/project.json`
- Create: `libs/workspace-bootstrap/src/{platform,installers,board,hooks,bootstrap,index}.js`
- Create: `libs/workspace-bootstrap/test/{platform,installers,board,hooks,bootstrap}.test.js`
- Delete: `src/{platform,installers,board,hooks,workspace}.js`, `test/{platform,installers,board,hooks}.test.js`

- [ ] **Step 1: Move the untouched files**

```bash
mkdir -p libs/workspace-bootstrap/src libs/workspace-bootstrap/test
git mv src/platform.js libs/workspace-bootstrap/src/platform.js
git mv src/installers.js libs/workspace-bootstrap/src/installers.js
git mv src/board.js libs/workspace-bootstrap/src/board.js
git mv src/hooks.js libs/workspace-bootstrap/src/hooks.js
git mv test/platform.test.js libs/workspace-bootstrap/test/platform.test.js
git mv test/installers.test.js libs/workspace-bootstrap/test/installers.test.js
git mv test/board.test.js libs/workspace-bootstrap/test/board.test.js
git mv test/hooks.test.js libs/workspace-bootstrap/test/hooks.test.js
```
None of these four files have cross-lib imports (`platform.js`: `node:path` only; `installers.js`: `./platform.js`, same lib; `board.js`: node builtins only; `hooks.js`: node builtins only) — no import edits. Their tests import only their own sibling `../src/*.js` — no edits.

- [ ] **Step 2: Create `libs/workspace-bootstrap/src/bootstrap.js`** (extracted from `src/workspace.js`, with the `hookCommand` self-referencing default removed — see the plan header's spec-refinement note)

```js
import path from 'node:path';
import { mkdir, access, rm } from 'node:fs/promises';
import { clone as defaultClone, defaultExec } from '@ai-sync/git';
import { EDITORS, launchCommand } from './platform.js';
import { planInstall } from './installers.js';
import { setStatus as defaultSetStatus, resolveBoardPath, initRepos } from './board.js';
import { installHooks as defaultInstallHooks } from './hooks.js';

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultRemove(p) {
  await rm(p, { recursive: true, force: true });
}

// Compact, filesystem-safe stamp like "20260621-143005" for suffixed checkouts.
export function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export async function bootstrap(config, options = {}) {
  const {
    workspaceDir,
    editor = 'claude',
    repoFilter,
    worktree,
    install = true,
    dryRun = false,
    offline = false,
    clone = defaultClone,
    exec = defaultExec,
    exists = pathExists,
    remove = defaultRemove,
    onExisting,
    timestamp = formatTimestamp,
    boardPath: boardPathOption,
    installRepoHooks = defaultInstallHooks,
    initBoard = initRepos,
    hookCommand,
    logger = console,
  } = options;

  if (!workspaceDir) throw new Error('bootstrap requires a workspaceDir');
  if (!EDITORS.includes(editor)) {
    throw new Error(`Unknown editor "${editor}" (known: ${EDITORS.join(', ')})`);
  }
  if (worktree && editor !== 'claude') {
    throw new Error('--worktree is only supported with --editor claude');
  }

  const tag = dryRun ? '[dry-run] ' : '';
  const repos = repoFilter
    ? config.repos.filter((r) => r.name === repoFilter)
    : config.repos;

  if (!dryRun) await mkdir(workspaceDir, { recursive: true });

  // The board lives beside the checkouts so the viewer and the per-repo hooks
  // agree on one path; the hooks shell out to this CLI to record transitions.
  const boardPath = boardPathOption ?? path.join(workspaceDir, '.ai-sync', 'board.json');

  const results = [];
  const workDirs = [];
  for (const repo of repos) {
    let checkout = path.join(workspaceDir, repo.name);

    let status;
    if (await exists(checkout)) {
      // Existing checkout: reuse it, or (interactively) re-clone elsewhere.
      // "reinstall" reuses a fixed "-reinstall" dir (overwritten each time);
      // "timestamp" clones into a fresh, uniquely stamped dir.
      const action = onExisting ? await onExisting(repo) : 'reuse';
      if (action === 'reuse') {
        logger.log(`${tag}= ${repo.name}: reusing existing checkout`);
        status = 'reused';
      } else {
        const suffix = action === 'reinstall' ? 'reinstall' : timestamp();
        checkout = path.join(workspaceDir, `${repo.name}-${suffix}`);
        if (action === 'reinstall' && (await exists(checkout))) {
          if (!dryRun) await remove(checkout);
          logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would remove' : 'removed'} previous ${path.basename(checkout)}`);
        }
        if (!dryRun) await clone(repo.url, checkout);
        logger.log(`${tag}✓ ${repo.name}: ${dryRun ? 'would clone' : 'cloned'} into ${path.basename(checkout)}`);
        status = 'cloned';
      }
    } else {
      if (!dryRun) await clone(repo.url, checkout);
      logger.log(`${tag}✓ ${repo.name}: ${dryRun ? 'would clone' : 'cloned'}`);
      status = 'cloned';
    }

    let workDir = checkout;
    if (worktree) {
      const wt = path.join(workspaceDir, `${repo.name}.${worktree.replace(/\//g, '-')}`);
      if (await exists(wt)) {
        logger.log(`  ${tag}${repo.name}: reusing worktree ${path.basename(wt)}`);
      } else {
        if (!dryRun) await exec('git', ['-C', checkout, 'worktree', 'add', wt, '-b', worktree], {});
        logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would add' : 'added'} worktree ${path.basename(wt)} (${worktree})`);
      }
      workDir = wt;
    }
    workDirs.push(workDir);

    if (!dryRun) await installRepoHooks(workDir, repo.name, boardPath, { command: hookCommand });

    let installed = false;
    if (install) {
      const plan = await planInstall(workDir, { exists, offline });
      if (plan) {
        if (!dryRun) await exec(plan.command, plan.args, { cwd: workDir });
        logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would' : 'ran'} ${plan.label} install${offline ? ' (offline)' : ''}`);
        installed = true;
      }
    }

    results.push({ repo: repo.name, status, installed });
  }

  if (!dryRun) await initBoard(boardPath, repos.map((r) => r.name));

  // Launch at the project directory itself when a single repo is targeted
  // (selected, --repo, or a single worktree); otherwise at the workspace root.
  const launchDir = workDirs.length === 1 ? workDirs[0] : workspaceDir;
  const relativeLaunch = path.relative(process.cwd(), launchDir) || '.';
  const command = launchCommand(editor, relativeLaunch);
  logger.log(`\nWorkspace ready at ${workspaceDir}`);
  logger.log(`Launch ${editor}:\n  ${command}`);
  if (editor === 'claude' && !worktree) {
    logger.log('\n→ Tip: isolate your work in a git worktree with --worktree <branch>');
  }

  return { workspaceDir, editor, command, results };
}
```

The only functional change from the original `workspace.js`: `hookCmd` is gone, and `installRepoHooks(...)` is called with `{ command: hookCommand }` directly instead of `{ command: hookCmd }` where `hookCmd` used to default to a self-computed path. `hookCommand` is `undefined` unless the caller supplies it — Task 8 makes `apps/workspace` always supply it, computed from *its own* location instead of the lib's.

- [ ] **Step 3: Create `libs/workspace-bootstrap/src/index.js`** (public barrel — only what `apps/workspace`'s CLI layer actually consumes)

```js
export { bootstrap, formatTimestamp } from './bootstrap.js';
export { resolveBoardPath, setStatus } from './board.js';
```

- [ ] **Step 4: Create `libs/workspace-bootstrap/test/bootstrap.test.js`** (the `bootstrap`/`formatTimestamp` tests extracted from `test/workspace.test.js`, lines 1–441 — everything up to and including `'bootstrap dry-run does not install hooks or init the board'`, excluding the `main`-routing tests which move to `apps/workspace` in Task 8)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap, formatTimestamp } from '../src/bootstrap.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

const rel = (p) => path.relative(process.cwd(), p) || '.';

const config = {
  defaultTargets: ['claude'],
  repos: [
    { name: 'a', url: 'git@host:a.git', technologies: ['nestjs'], targets: ['claude'] },
    { name: 'b', url: 'git@host:b.git', technologies: ['nestjs'], targets: ['claude'] },
  ],
};

test('bootstrap requires a workspaceDir', async () => {
  await assert.rejects(() => bootstrap(config, { logger: silentLogger() }), /requires a workspaceDir/);
});

test('bootstrap rejects an unknown editor', async () => {
  await assert.rejects(
    () => bootstrap(config, { workspaceDir: '/tmp/x', editor: 'vim', logger: silentLogger() }),
    /Unknown editor "vim"/,
  );
});

test('clones missing repos, reuses present ones, and installs when package.json exists', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const execCalls = [];
  const present = new Set([path.join(ws, 'b'), path.join(ws, 'a', 'package.json')]);
  const result = await bootstrap(config, {
    workspaceDir: ws,
    clone: async (url, dir) => { cloned.push({ url, dir }); },
    exec: async (file, args, opts) => { execCalls.push({ file, args, opts }); },
    exists: async (p) => present.has(p),
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, [{ url: 'git@host:a.git', dir: path.join(ws, 'a') }]);
  assert.deepEqual(result.results, [
    { repo: 'a', status: 'cloned', installed: true },
    { repo: 'b', status: 'reused', installed: false },
  ]);
  assert.deepEqual(execCalls, [{ file: 'pnpm', args: ['install', '--prefer-offline'], opts: { cwd: path.join(ws, 'a') } }]);
  assert.equal(result.command, `cd "${rel(ws)}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('--no-install path skips pnpm and the vscode editor yields a code command', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    editor: 'vscode',
    install: false,
    repoFilter: 'a',
    clone: async () => {},
    exec: async (...c) => { execCalls.push(c); },
    exists: async () => false,
    logger: silentLogger(),
  });

  assert.equal(execCalls.length, 0);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'cloned', installed: false }]);
  assert.equal(result.command, `code "${rel(path.join(ws, 'a'))}"`);
  await rm(ws, { recursive: true, force: true });
});

test('bootstrap works against the real filesystem (default exists)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  // Pre-create repo "b" with a package.json so it is reused and installed.
  await mkdir(path.join(ws, 'b'), { recursive: true });
  await writeFile(path.join(ws, 'b', 'package.json'), '{}\n');

  const execCalls = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    clone: async (url, dir) => { await mkdir(dir, { recursive: true }); },
    exec: async (file, args, opts) => { execCalls.push({ file, opts }); },
    logger: silentLogger(),
  });

  assert.deepEqual(result.results, [
    { repo: 'a', status: 'cloned', installed: false },
    { repo: 'b', status: 'reused', installed: true },
  ]);
  assert.deepEqual(execCalls, [{ file: 'pnpm', opts: { cwd: path.join(ws, 'b') } }]);
  await rm(ws, { recursive: true, force: true });
});

test('dry-run reports actions without cloning or installing', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const execCalls = [];
  // "a" already checked out with a package.json -> reused + would install.
  // "b" absent -> would clone.
  const present = new Set([path.join(ws, 'a'), path.join(ws, 'a', 'package.json')]);
  const logs = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    dryRun: true,
    clone: async (url, dir) => { cloned.push({ url, dir }); },
    exec: async (...c) => { execCalls.push(c); },
    exists: async (p) => present.has(p),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });

  assert.deepEqual(cloned, []);
  assert.deepEqual(execCalls, []);
  assert.deepEqual(result.results, [
    { repo: 'a', status: 'reused', installed: true },
    { repo: 'b', status: 'cloned', installed: false },
  ]);
  assert.ok(logs.some((m) => m.includes('[dry-run]') && m.includes('would clone')));
  assert.ok(logs.some((m) => m.includes('[dry-run]') && m.includes('would pnpm install')));
  await rm(ws, { recursive: true, force: true });
});

test('--worktree is only supported with the claude editor', async () => {
  await assert.rejects(
    () => bootstrap(config, { workspaceDir: '/tmp/x', editor: 'vscode', worktree: 'feat/x', logger: silentLogger() }),
    /--worktree is only supported with --editor claude/,
  );
});

test('claude + --worktree adds a worktree, installs in it, and launches there', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  // checkout "a" already present (reused); worktree absent; worktree has a package.json.
  const present = new Set([path.join(ws, 'a'), path.join(ws, 'a.feat-x', 'package.json')]);
  const result = await bootstrap(config, {
    workspaceDir: ws,
    editor: 'claude',
    worktree: 'feat/x',
    repoFilter: 'a',
    clone: async () => { throw new Error('should not clone'); },
    exec: async (file, args, opts) => { execCalls.push({ file, args, opts }); },
    exists: async (p) => present.has(p),
    logger: silentLogger(),
  });

  const wt = path.join(ws, 'a.feat-x');
  assert.deepEqual(execCalls, [
    { file: 'git', args: ['-C', path.join(ws, 'a'), 'worktree', 'add', wt, '-b', 'feat/x'], opts: {} },
    { file: 'pnpm', args: ['install', '--prefer-offline'], opts: { cwd: wt } },
  ]);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'reused', installed: true }]);
  assert.equal(result.command, `cd "${rel(wt)}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('reuses existing worktrees and launches at the workspace root for multiple repos', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  // both worktrees already exist -> reused; no package.json -> no install.
  const present = new Set([path.join(ws, 'a.feat'), path.join(ws, 'b.feat')]);
  const result = await bootstrap(config, {
    workspaceDir: ws,
    editor: 'claude',
    worktree: 'feat',
    clone: async () => {},
    exec: async (...c) => { execCalls.push(c); },
    exists: async (p) => present.has(p),
    logger: silentLogger(),
  });

  assert.deepEqual(result.results, [
    { repo: 'a', status: 'cloned', installed: false },
    { repo: 'b', status: 'cloned', installed: false },
  ]);
  assert.equal(execCalls.length, 0);
  assert.equal(result.command, `cd "${rel(ws)}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('dry-run previews worktree creation without side effects', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const logs = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    editor: 'claude',
    worktree: 'feat/y',
    repoFilter: 'a',
    dryRun: true,
    clone: async () => { throw new Error('should not clone'); },
    exec: async (...c) => { execCalls.push(c); },
    exists: async () => false,
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });

  assert.equal(execCalls.length, 0);
  assert.ok(logs.some((m) => m.includes('[dry-run]') && m.includes('would add worktree')));
  assert.equal(result.command, `cd "${rel(path.join(ws, 'a.feat-y'))}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('launch command falls back to "." when the launch dir is the cwd', async () => {
  const result = await bootstrap(config, {
    workspaceDir: process.cwd(),
    dryRun: true,
    clone: async () => {},
    exec: async () => {},
    exists: async () => false,
    logger: silentLogger(),
  });

  assert.equal(result.command, 'cd "." && claude');
});

test('formatTimestamp renders a zero-padded YYYYMMDD-HHMMSS stamp', () => {
  assert.equal(formatTimestamp(new Date(2026, 5, 21, 14, 30, 5)), '20260621-143005');
});

test('onExisting "reuse" keeps the existing checkout and does not clone', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    onExisting: async (repo) => { assert.equal(repo.name, 'a'); return 'reuse'; },
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    exists: async (p) => p === path.join(ws, 'a'),
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, []);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'reused', installed: false }]);
  await rm(ws, { recursive: true, force: true });
});

test('onExisting "reinstall" clones into <name>-reinstall (no removal when absent)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const removed = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    onExisting: async () => 'reinstall',
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    remove: async (p) => { removed.push(p); },
    exists: async (p) => p === path.join(ws, 'a'),
    logger: silentLogger(),
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(cloned, [path.join(ws, 'a-reinstall')]);
  assert.deepEqual(result.results, [{ repo: 'a', status: 'cloned', installed: false }]);
  assert.equal(result.command, `cd "${rel(path.join(ws, 'a-reinstall'))}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('onExisting "reinstall" removes a previous -reinstall checkout first', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const removed = [];
  const present = new Set([path.join(ws, 'a'), path.join(ws, 'a-reinstall')]);
  await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    onExisting: async () => 'reinstall',
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    remove: async (p) => { removed.push(p); },
    exists: async (p) => present.has(p),
    logger: silentLogger(),
  });

  assert.deepEqual(removed, [path.join(ws, 'a-reinstall')]);
  assert.deepEqual(cloned, [path.join(ws, 'a-reinstall')]);
  await rm(ws, { recursive: true, force: true });
});

test('onExisting "timestamp" clones into a uniquely stamped directory', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    onExisting: async () => 'timestamp',
    timestamp: () => '20260621-143005',
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    exists: async (p) => p === path.join(ws, 'a'),
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, [path.join(ws, 'a-20260621-143005')]);
  assert.equal(result.command, `cd "${rel(path.join(ws, 'a-20260621-143005'))}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('dry-run reinstall previews removal and clone without side effects', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const removed = [];
  const logs = [];
  const present = new Set([path.join(ws, 'a'), path.join(ws, 'a-reinstall')]);
  await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    dryRun: true,
    onExisting: async () => 'reinstall',
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    remove: async (p) => { removed.push(p); },
    exists: async (p) => present.has(p),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(cloned, []);
  assert.ok(logs.some((m) => m.includes('[dry-run]') && m.includes('would remove')));
  assert.ok(logs.some((m) => m.includes('[dry-run]') && m.includes('would clone into a-reinstall')));
  await rm(ws, { recursive: true, force: true });
});

test('reinstall against the real filesystem removes the stale dir (default remove)', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  await mkdir(path.join(ws, 'a'), { recursive: true });
  await mkdir(path.join(ws, 'a-reinstall'), { recursive: true });
  await writeFile(path.join(ws, 'a-reinstall', 'stale.txt'), 'x');

  const result = await bootstrap(config, {
    workspaceDir: ws,
    repoFilter: 'a',
    install: false,
    onExisting: async () => 'reinstall',
    clone: async (url, dir) => { await mkdir(dir, { recursive: true }); },
    exec: async () => {},
    logger: silentLogger(),
  });

  assert.deepEqual(result.results, [{ repo: 'a', status: 'cloned', installed: false }]);
  await assert.rejects(() => access(path.join(ws, 'a-reinstall', 'stale.txt')));
  await rm(ws, { recursive: true, force: true });
});

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

- [ ] **Step 5: Delete the old `src/workspace.js` and `test/workspace.test.js`**

They're fully absorbed (this task takes `bootstrap`/`formatTimestamp`/`platform`/`installers`/`board`/`hooks`; Task 8 takes `main`/`runStatus`/`runBootstrapMain`):
```bash
git rm src/workspace.js test/workspace.test.js
```

- [ ] **Step 6: Create `libs/workspace-bootstrap/package.json`**

```json
{
  "name": "@ai-sync/workspace-bootstrap",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.js",
  "dependencies": {
    "@ai-sync/git": "*"
  }
}
```

- [ ] **Step 7: Create `libs/workspace-bootstrap/project.json`**

```json
{
  "name": "workspace-bootstrap",
  "sourceRoot": "libs/workspace-bootstrap/src",
  "projectType": "library",
  "tags": ["scope:workspace", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/workspace-bootstrap/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 libs/workspace-bootstrap/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 8: Verify**

```bash
npm install
npx nx run workspace-bootstrap:test
```
Expected: all platform/installers/board/hooks/bootstrap tests pass, 100% coverage.

- [ ] **Step 9: Commit**

```bash
git add libs/workspace-bootstrap package.json package-lock.json
git commit -m "chore(nx): extract libs/workspace-bootstrap, split bootstrap() out of workspace.js"
```

---

### Task 7: `apps/sync`

**Files:**
- Create: `apps/sync/package.json`, `apps/sync/project.json`, `apps/sync/src/main.js`, `apps/sync/bin/sync.js`, `apps/sync/test/main.test.js`
- Delete: `src/index.js`, `bin/sync.js`, `test/index.test.js`

- [ ] **Step 1: Move and rename**

```bash
mkdir -p apps/sync/src apps/sync/bin apps/sync/test
git mv src/index.js apps/sync/src/main.js
git mv bin/sync.js apps/sync/bin/sync.js
git mv test/index.test.js apps/sync/test/main.test.js
```

- [ ] **Step 2: Fix `apps/sync/src/main.js`'s imports**

Change:
```js
import { loadConfig as defaultLoadConfig } from './config.js';
import { run as defaultRun } from './pipeline.js';
```
to:
```js
import { loadConfig as defaultLoadConfig } from '@ai-sync/config';
import { run as defaultRun } from '@ai-sync/skill-sync';
```
Rest of the file (the `main()` function body) is unchanged.

- [ ] **Step 3: Fix `apps/sync/bin/sync.js`'s import**

Change:
```js
import { main } from '../src/index.js';
```
to:
```js
import { main } from '../src/main.js';
```

- [ ] **Step 4: Fix `apps/sync/test/main.test.js`'s import**

Change:
```js
import { main } from '../src/index.js';
```
to:
```js
import { main } from '../src/main.js';
```

- [ ] **Step 5: Create `apps/sync/package.json`**

```json
{
  "name": "@ai-sync/sync",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "ai-sync": "./bin/sync.js" },
  "dependencies": {
    "@ai-sync/config": "*",
    "@ai-sync/skill-sync": "*"
  }
}
```

- [ ] **Step 6: Create `apps/sync/project.json`**

```json
{
  "name": "sync",
  "sourceRoot": "apps/sync/src",
  "projectType": "application",
  "tags": ["scope:sync", "type:app"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"apps/sync/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 apps/sync/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 7: Verify**

```bash
npm install
npx nx run sync:test
node apps/sync/bin/sync.js --config repos.json --dry-run
```
Expected: tests pass with 100% coverage; the dry-run command prints the same preview it does today.

- [ ] **Step 8: Commit**

```bash
git add apps/sync package.json package-lock.json
git commit -m "chore(nx): extract apps/sync"
```

---

### Task 8: `apps/workspace`

**Files:**
- Create: `apps/workspace/package.json`, `apps/workspace/project.json`, `apps/workspace/src/main.js`, `apps/workspace/bin/workspace.js`, `apps/workspace/test/main.test.js`
- Delete: `bin/workspace.js`

- [ ] **Step 1: Move the bin entry**

```bash
mkdir -p apps/workspace/src apps/workspace/bin apps/workspace/test
git mv bin/workspace.js apps/workspace/bin/workspace.js
```

- [ ] **Step 2: Create `apps/workspace/src/main.js`** (the CLI-orchestration slice of the old `src/workspace.js`: `main`, `runStatus`, `runBootstrapMain` — now importing `bootstrap`/`resolveBoardPath`/`setStatus` from the lib, and computing `hookCommand` itself instead of relying on a lib-side default)

```js
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig as defaultLoadConfig } from '@ai-sync/config';
import {
  bootstrap,
  resolveBoardPath,
  setStatus as defaultSetStatus,
} from '@ai-sync/workspace-bootstrap';

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

async function runBootstrapMain(argv, deps = {}) {
  const {
    loadConfig = defaultLoadConfig,
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
      workspace: { type: 'string' },
      editor: { type: 'string', default: 'claude' },
      repo: { type: 'string' },
      worktree: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
    },
  });

  if (!values.config) throw new Error('Missing required --config <path>');
  if (!values.workspace) throw new Error('Missing required --workspace <dir>');

  const config = await loadConfig(values.config);

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

- [ ] **Step 3: Fix `apps/workspace/bin/workspace.js`'s import**

Change:
```js
import { main } from '../src/workspace.js';
```
to:
```js
import { main } from '../src/main.js';
```
(rest of the file — the `selectRepo`/`onExisting` inquirer prompts and the `main(...).then(...)` call — is unchanged.)

- [ ] **Step 4: Create `apps/workspace/test/main.test.js`** (the `main`-routing tests extracted from the old `test/workspace.test.js`, lines 443–558)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/main.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

const config = {
  defaultTargets: ['claude'],
  repos: [
    { name: 'a', url: 'git@host:a.git', technologies: ['nestjs'], targets: ['claude'] },
    { name: 'b', url: 'git@host:b.git', technologies: ['nestjs'], targets: ['claude'] },
  ],
};

test('main requires --config', async () => {
  await assert.rejects(
    () => main([], { loadConfig: async () => config, logger: silentLogger() }),
    /Missing required --config/,
  );
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

- [ ] **Step 5: Create `apps/workspace/package.json`**

```json
{
  "name": "@ai-sync/workspace",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "ai-workspace": "./bin/workspace.js" },
  "dependencies": {
    "@ai-sync/config": "*",
    "@ai-sync/workspace-bootstrap": "*",
    "@inquirer/prompts": "^7.2.0"
  }
}
```

- [ ] **Step 6: Create `apps/workspace/project.json`**

```json
{
  "name": "workspace",
  "sourceRoot": "apps/workspace/src",
  "projectType": "application",
  "tags": ["scope:workspace", "type:app"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"apps/workspace/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 apps/workspace/test/**/*.test.js"
      }
    }
  }
}
```

- [ ] **Step 7: Remove `@inquirer/prompts` from the root `package.json`'s `dependencies`** (it now lives in `apps/workspace/package.json`).

- [ ] **Step 8: Verify**

```bash
npm install
npx nx run workspace:test
node apps/workspace/bin/workspace.js --config repos.json --workspace /tmp/ai-sync-wk-check --dry-run
```
Expected: tests pass with 100% coverage; the dry-run prints the same preview as today (clone/hook/install lines per repo).

- [ ] **Step 9: Commit**

```bash
git add apps/workspace package.json package-lock.json
git commit -m "chore(nx): extract apps/workspace, compute hookCommand at the app layer"
```

---

### Task 9: `apps/board`

This is the highest-risk task (per the design spec) — it touches the most existing working configuration. Generate into a temporary path first since `apps/board` already has real content, then port the existing dashboard code in, fixing the two verified generator defects (`index.html`'s `main.ts` reference, and the missing Tailwind setup).

**Files:**
- Create (generated then edited): `apps/board/{package.json,vite.config.js,index.html,src/main.js,src/app/**}` — deleted again below
- Move as-is: `apps/board/server.js`, `apps/board/server.test.js`, `apps/board/src/{App.vue,App.test.js,Card.vue,Card.test.js,Column.vue,FilterBar.vue,FilterBar.test.js,RepoDetail.vue,RepoDetail.test.js,SummaryHeader.vue,SummaryHeader.test.js,useBoard.js,useBoard.test.js,useConfig.js,useConfig.test.js,useNotifications.js,useNotifications.test.js,useRelativeTime.js,useRelativeTime.test.js,style.css}`, `apps/board/{tailwind.config.js,postcss.config.js,eslint.config.js}`
- Delete: `apps/board/{pnpm-lock.yaml}` (old standalone package)

- [ ] **Step 1: Preserve the existing app under a temp name**

```bash
git mv apps/board apps/board-old
```

- [ ] **Step 2: Generate the Nx-wired Vue app skeleton**

```bash
npx nx g @nx/vue:app apps/board \
  --style=css --bundler=vite --unitTestRunner=vitest --e2eTestRunner=none \
  --linter=eslint --js=true --routing=false \
  --tags=scope:board,type:app --no-interactive
```
This creates `apps/board/{package.json,vite.config.js,index.html,src/main.js,src/app/App.vue,src/app/App.spec.js,src/styles.css,eslint.config.mjs}` plus root `tsconfig.base.json`/`tsconfig.json` (needed by the generator's Vue tooling — this is the one place in the repo that keeps a tsconfig, scoped to `apps/board`'s own benefit; nothing else references it) and registers `@nx/js/typescript`, `@nx/vite/plugin`, `@nx/vitest` in `nx.json`.

- [ ] **Step 3: Fix the known generator bug in `index.html`**

Replace the generated `apps/board/index.html` with the project's existing one (this also fixes the `main.ts`/`main.js` mismatch that breaks `nx run board:build` out of the box, and restores the existing `id="app"` / title):

```bash
cp apps/board-old/index.html apps/board/index.html
```

- [ ] **Step 4: Port the existing Vue app code over the generator's placeholders**

```bash
rm -rf apps/board/src/app apps/board/src/styles.css
git mv apps/board-old/src/App.vue apps/board/src/App.vue
git mv apps/board-old/src/App.test.js apps/board/src/App.test.js
git mv apps/board-old/src/Card.vue apps/board/src/Card.vue
git mv apps/board-old/src/Card.test.js apps/board/src/Card.test.js
git mv apps/board-old/src/Column.vue apps/board/src/Column.vue
git mv apps/board-old/src/FilterBar.vue apps/board/src/FilterBar.vue
git mv apps/board-old/src/FilterBar.test.js apps/board/src/FilterBar.test.js
git mv apps/board-old/src/RepoDetail.vue apps/board/src/RepoDetail.vue
git mv apps/board-old/src/RepoDetail.test.js apps/board/src/RepoDetail.test.js
git mv apps/board-old/src/SummaryHeader.vue apps/board/src/SummaryHeader.vue
git mv apps/board-old/src/SummaryHeader.test.js apps/board/src/SummaryHeader.test.js
git mv apps/board-old/src/useBoard.js apps/board/src/useBoard.js
git mv apps/board-old/src/useBoard.test.js apps/board/src/useBoard.test.js
git mv apps/board-old/src/useConfig.js apps/board/src/useConfig.js
git mv apps/board-old/src/useConfig.test.js apps/board/src/useConfig.test.js
git mv apps/board-old/src/useNotifications.js apps/board/src/useNotifications.js
git mv apps/board-old/src/useNotifications.test.js apps/board/src/useNotifications.test.js
git mv apps/board-old/src/useRelativeTime.js apps/board/src/useRelativeTime.js
git mv apps/board-old/src/useRelativeTime.test.js apps/board/src/useRelativeTime.test.js
git mv apps/board-old/src/style.css apps/board/src/style.css
git mv apps/board-old/src/main.js apps/board/src/main.js
rm apps/board/src/app/App.spec.js 2>/dev/null; true
```
None of these files' internal imports reference generator-specific paths (they only import sibling files by relative path, `vue`, or `vitest`), so no import edits are needed — they're a pure move.

- [ ] **Step 5: Port the server, Tailwind/PostCSS, and eslint config as-is**

```bash
git mv apps/board-old/server.js apps/board/server.js
git mv apps/board-old/server.test.js apps/board/server.test.js
git mv apps/board-old/tailwind.config.js apps/board/tailwind.config.js
git mv apps/board-old/postcss.config.js apps/board/postcss.config.js
rm apps/board/eslint.config.mjs
git mv apps/board-old/eslint.config.js apps/board/eslint.config.js
```

- [ ] **Step 6: Reconcile `apps/board/vite.config.js`**

Replace its generated contents with:
```js
/// <reference types='vitest' />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/board',
  plugins: [vue()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.js'] },
});
```
This keeps `build.outDir` at `apps/board/dist` (what `server.js` already expects — verified: its `distDir` default is `path.join(<dirname of server.js>, 'dist')`) and keeps the exact existing `test.include` pattern (`src/**/*.test.js`, matching every test file above) instead of the generator's default `{src,tests}/**/*.{test,spec}...` glob.

- [ ] **Step 7: Reconcile `apps/board/package.json`**

Replace the generated contents with:
```json
{
  "name": "@ai-sync/board",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.1.0",
    "@vue/test-utils": "^2.4.6",
    "autoprefixer": "^10.4.0",
    "eslint-plugin-vue": "^9.33.0",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "nx": {
    "tags": ["scope:board", "type:app"],
    "targets": {
      "start": {
        "executor": "nx:run-commands",
        "dependsOn": ["build"],
        "options": { "command": "node apps/board/server.js" }
      }
    }
  }
}
```
This drops the generator's auto-pinned `vue`/`@vitejs/plugin-vue`/`vitest` versions in favor of the exact versions this project already ran with, and adds the custom `start` target (running the zero-dependency Node server) that the generator has no equivalent for — matching today's `apps/board`'s own `"start": "node server.js"` script and this repo's root `"start"` script (Task 12 rewires that to `nx run board:start`).

- [ ] **Step 8: Remove the old standalone app directory**

```bash
rm -rf apps/board-old
```

- [ ] **Step 9: Install and verify**

```bash
npm install
npx nx run board:lint
npx nx run board:test
npx nx run board:build
```
Expected: lint clean, all Vue component/composable/server tests pass, and `nx run board:build` succeeds (this is the step that failed pre-fix in the sandbox trial — confirm `apps/board/dist/index.html` exists after).

- [ ] **Step 10: Manual browser smoke test**

```bash
node apps/board/server.js --board repos.json --port 4180
```
Open `http://localhost:4180` in a browser. Confirm the kanban board renders (columns, summary header) exactly as it does on `main` today — this is the step the design spec calls out as needing more than green tests.

- [ ] **Step 11: Commit**

`apps/board-old` was removed with a plain `rm -rf` (not `git rm`), so its remaining tracked files (anything not already moved out via `git mv`) show up as deletions in `git status` — stage everything at once rather than listing individual surviving paths:

```bash
git add -A
git commit -m "chore(nx): regenerate apps/board via @nx/vue, port existing dashboard code"
```

---

### Task 10: Module boundaries

**Files:**
- Modify: `eslint.config.js`
- Delete: `src/`, `bin/`, `test/` (now empty)

- [ ] **Step 1: Confirm the old top-level `src/`, `bin/`, `test/` are empty and remove them**

```bash
find src bin test -type f 2>/dev/null
```
Expected: no output (Tasks 2–9 moved every file out). Then:
```bash
rm -rf src bin test
```

- [ ] **Step 2: Replace the root `eslint.config.js`** with a version scoped to what's left at the root (nothing — all code now lives under `apps/`/`libs/`) plus the boundaries rule every project's own `eslint.config.js`... — this repo doesn't generate per-project eslint configs (Task 2–8's libs/apps rely on the root config directly, there's no per-project override needed since they're all plain JS with the same lint rules; only `apps/board` has its own `eslint.config.js`, kept from Task 9, which the `@nx/eslint/plugin` picks up automatically instead of the root one for files under `apps/board/`).

```js
import js from '@eslint/js';
import globals from 'globals';
import nx from '@nx/eslint-plugin';

export default [
  {
    ignores: [
      'node_modules/**',
      'wk/**',
      'docs/**',
      '.claude/**',
      '.superpowers/**',
      '**/dist/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:sync', onlyDependOnLibsWithTags: ['scope:shared', 'scope:sync'] },
            { sourceTag: 'scope:workspace', onlyDependOnLibsWithTags: ['scope:shared', 'scope:workspace'] },
            { sourceTag: 'scope:board', onlyDependOnLibsWithTags: ['scope:board'] },
          ],
        },
      ],
    },
  },
];
```

- [ ] **Step 3: Verify boundaries are enforced and nothing currently violates them**

```bash
npx nx run-many -t lint
```
Expected: every project (`git`, `renderers`, `config`, `skill-sync`, `workspace-bootstrap`, `sync`, `workspace`, `board`) lints clean — this is the real dependency graph built in Tasks 2–9, so a clean run here confirms the tags match reality (`config`→`renderers` shared-to-shared, `skill-sync`→`git`+`renderers` sync-to-shared, `workspace-bootstrap`→`git` workspace-to-shared, `sync`→`config`+`skill-sync`, `workspace`→`config`+`workspace-bootstrap`, `board` standalone).

As a one-off sanity check that the rule actually rejects violations (don't commit this part): temporarily add `import '@ai-sync/workspace-bootstrap';` to `libs/skill-sync/src/pipeline.js` and re-run `npx nx run skill-sync:lint` — expect an `@nx/enforce-module-boundaries` error. Revert the temporary import.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(nx): remove old top-level src/bin/test, wire module boundaries"
```

---

### Task 11: CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Replace the two-job workflow with a single Nx-orchestrated job**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci:
    name: Nx (lint, test, build)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Lint
        run: npx nx run-many -t lint
      - name: Test (100% coverage gate per project)
        run: npx nx run-many -t test
      - name: Build
        run: npx nx run-many -t build
```

- [ ] **Step 2: Verify locally**

```bash
npx nx run-many -t lint
npx nx run-many -t test
npx nx run-many -t build
```
Expected: all pass (only `board` has a `build` target today; `run-many -t build` on projects without one is a no-op, not a failure).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run lint/test/build through Nx in a single job"
```

---

### Task 12: Root scripts, README check, final verification

**Files:**
- Modify: `package.json`
- Modify (if needed): `README.md`

- [ ] **Step 1: Finalize the root `package.json`**

```json
{
  "name": "ai-sync",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "workspaces": [
    "apps/*",
    "libs/*"
  ],
  "bin": {
    "ai-sync": "apps/sync/bin/sync.js",
    "ai-workspace": "apps/workspace/bin/workspace.js"
  },
  "scripts": {
    "lint": "nx run-many -t lint",
    "test": "nx run-many -t test",
    "start": "nx run board:start",
    "sync": "node apps/sync/bin/sync.js",
    "wk": "node apps/workspace/bin/workspace.js --config repos.json --workspace wk",
    "board:build": "nx run board:build",
    "test:board": "nx run board:test"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@nx/eslint": "23.1.0",
    "@nx/eslint-plugin": "23.1.0",
    "@nx/vue": "23.1.0",
    "eslint": "^9.39.4",
    "globals": "^17.7.0",
    "nx": "23.1.0"
  }
}
```
(`gray-matter` and `@inquirer/prompts` are already removed per Tasks 5 and 8; the `@nx/js`/`@types/node`/etc. the trial sandbox pulled in were never installed in the real repo since Tasks 2–8 hand-author `project.json`/`package.json` instead of running `@nx/js:library`.)

- [ ] **Step 2: Diff documented commands against actual behavior**

Run every command `README.md` documents and confirm output/behavior is unchanged from before this migration:
```bash
node apps/sync/bin/sync.js --config repos.json --dry-run
node apps/workspace/bin/workspace.js --config repos.json --workspace /tmp/ai-sync-wk-final --dry-run
npm run lint
npm test
npm run board:build
npm start &  # then curl http://localhost:4180/api/board, then kill the process
npm run test:board
```
If any documented command's output changed (path shown, flag behavior, etc.), update the corresponding section of `README.md` to match. Based on this plan's design, nothing should have changed — this step exists to catch anything missed.

- [ ] **Step 3: Full-repo verification**

```bash
npx nx run-many -t lint test build
```
Expected: all 8 projects (`git`, `renderers`, `config`, `skill-sync`, `workspace-bootstrap`, `sync`, `workspace`, `board`) pass lint and test (100% coverage each), `board` builds successfully.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(nx): finalize root scripts for the Nx workspace"
```
