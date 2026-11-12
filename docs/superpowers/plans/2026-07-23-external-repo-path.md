# External Repo Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `repos.json` point a repo at an existing local checkout via an optional `path` field, so `ai-workspace bootstrap` wires up hooks/install/board-tracking there instead of requiring a fresh clone into the managed `--workspace` folder (`wk/`).

**Architecture:** `libs/config` accepts and passes through an optional, type-checked `path` string per repo. `libs/workspace-bootstrap`'s `bootstrap()` uses `path.resolve(repo.path)` as the checkout location when present (falling back to today's `workspaceDir/repo.name`); every downstream step (exists-check/reuse, clone-if-missing, hook install, dependency install, board registration) is already location-agnostic and needs no change. Worktree and reinstall/timestamp re-clone locations are derived from `path.dirname(checkout)` instead of always `workspaceDir`, which is a no-op for existing `wk/`-based repos but keeps external repos' side-effects beside their real location.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), no new dependencies.

**Reference:** Full rationale and decisions in `docs/superpowers/specs/2026-07-23-external-repo-path-design.md`.

---

### Task 1: Config schema — optional `path` field

**Files:**
- Modify: `libs/config/src/config.js:25-38` (`normalizeRepo`)
- Test: `libs/config/test/config.test.js`

- [x] **Step 1: Write the failing tests**

Append to `libs/config/test/config.test.js`:

```js
test('parseConfig passes through an optional path field', () => {
  const cfg = parseConfig(JSON.stringify({
    repos: [{ name: 'a', url: 'u', path: '/tmp/checkouts/a', technologies: ['t'], targets: ['claude'] }],
  }));
  assert.equal(cfg.repos[0].path, '/tmp/checkouts/a');
});

test('parseConfig omits path when not provided', () => {
  const cfg = parseConfig(JSON.stringify({
    repos: [{ name: 'a', url: 'u', technologies: ['t'], targets: ['claude'] }],
  }));
  assert.equal('path' in cfg.repos[0], false);
});

test('parseConfig rejects a non-string path', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"],"targets":["claude"],"path":123}]}'),
    /"path" must be a string/,
  );
});
```

- [x] **Step 2: Run the tests to verify the new ones fail**

Run: `npx nx test config`
Expected: `parseConfig passes through an optional path field` FAILs (`cfg.repos[0].path` is `undefined`, not `/tmp/checkouts/a`); `parseConfig rejects a non-string path` FAILs (no error thrown — `assert.throws` fails); `parseConfig omits path when not provided` PASSes already (no regression yet, nothing to omit).

- [x] **Step 3: Implement the minimal change**

In `libs/config/src/config.js`, replace the `normalizeRepo` function:

```js
function normalizeRepo(repo, index, defaultTargets, valid) {
  const label = repo.name ? `repos[${index}] (${repo.name})` : `repos[${index}]`;
  if (!repo.name) throw new Error(`repos[${index}]: missing "name"`);
  if (!repo.url) throw new Error(`${label}: missing "url"`);
  if (!Array.isArray(repo.technologies) || repo.technologies.length === 0) {
    throw new Error(`${label}: "technologies" must be a non-empty array`);
  }
  if (repo.path !== undefined && typeof repo.path !== 'string') {
    throw new Error(`${label}: "path" must be a string`);
  }
  const targets = repo.targets ?? defaultTargets;
  validateTargets(targets, valid, `${label}.targets`);
  if (targets.length === 0) {
    throw new Error(`${label}: no targets (set repo.targets or defaultTargets)`);
  }
  return {
    name: repo.name,
    url: toHttpsUrl(repo.url),
    technologies: repo.technologies,
    targets,
    ...(repo.path ? { path: repo.path } : {}),
  };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx nx test config`
Expected: PASS, all tests green, coverage gate (100% lines/functions/branches on `libs/config/src/**`) satisfied — the new `if` and the `path ? … : …` spread each have both branches exercised by the three new tests plus every pre-existing path-less test.

- [ ] **Step 5: Commit**

```bash
git add libs/config/src/config.js libs/config/test/config.test.js
git commit -m "feat(config): accept optional per-repo path field"
```

---

### Task 2: Bootstrap — use external `path` as the checkout location

**Files:**
- Modify: `libs/workspace-bootstrap/src/bootstrap.js:74-114`
- Test: `libs/workspace-bootstrap/test/bootstrap.test.js`

- [x] **Step 1: Write the failing tests**

Append to `libs/workspace-bootstrap/test/bootstrap.test.js` (uses the already-imported `mkdtemp`, `tmpdir`, `rm`, `path`, `bootstrap`, `silentLogger`, `rel`):

```js
const configWithPath = {
  defaultTargets: ['claude'],
  repos: [
    { name: 'ext', url: 'git@host:ext.git', path: '/abs/external/ext', technologies: ['nestjs'], targets: ['claude'] },
  ],
};

test('reuses an existing repo at its external "path", installing hooks there, without cloning into workspaceDir', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const hooksInstalled = [];
  const result = await bootstrap(configWithPath, {
    workspaceDir: ws,
    clone: async (url, dir) => { cloned.push({ url, dir }); },
    exec: async () => {},
    exists: async (p) => p === '/abs/external/ext',
    installRepoHooks: async (dir, repo, boardPath) => { hooksInstalled.push({ dir, repo, boardPath }); },
    initBoard: async () => {},
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, []);
  assert.deepEqual(hooksInstalled, [
    { dir: '/abs/external/ext', repo: 'ext', boardPath: path.join(ws, '.ai-sync', 'board.json') },
  ]);
  assert.deepEqual(result.results, [{ repo: 'ext', status: 'reused', installed: false }]);
  assert.equal(result.command, `cd "${rel('/abs/external/ext')}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('clones into an external "path" that does not exist yet, instead of workspaceDir', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const result = await bootstrap(configWithPath, {
    workspaceDir: ws,
    clone: async (url, dir) => { cloned.push({ url, dir }); },
    exec: async () => {},
    exists: async () => false,
    installRepoHooks: async () => {},
    initBoard: async () => {},
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, [{ url: 'git@host:ext.git', dir: '/abs/external/ext' }]);
  assert.deepEqual(result.results, [{ repo: 'ext', status: 'cloned', installed: false }]);
  await rm(ws, { recursive: true, force: true });
});

test('--worktree places the worktree beside an external "path" repo, not inside workspaceDir', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const execCalls = [];
  const wt = '/abs/external/ext.feat-x';
  const result = await bootstrap(configWithPath, {
    workspaceDir: ws,
    editor: 'claude',
    worktree: 'feat/x',
    clone: async () => { throw new Error('should not clone'); },
    exec: async (file, args, opts) => { execCalls.push({ file, args, opts }); },
    exists: async (p) => p === '/abs/external/ext',
    installRepoHooks: async () => {},
    initBoard: async () => {},
    logger: silentLogger(),
  });

  assert.deepEqual(execCalls, [
    { file: 'git', args: ['-C', '/abs/external/ext', 'worktree', 'add', wt, '-b', 'feat/x'], opts: {} },
  ]);
  assert.equal(result.command, `cd "${rel(wt)}" && claude`);
  await rm(ws, { recursive: true, force: true });
});

test('onExisting "reinstall" for a path-based repo clones beside the external path, not into workspaceDir', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const cloned = [];
  const result = await bootstrap(configWithPath, {
    workspaceDir: ws,
    onExisting: async () => 'reinstall',
    clone: async (url, dir) => { cloned.push(dir); },
    exec: async () => {},
    exists: async (p) => p === '/abs/external/ext',
    installRepoHooks: async () => {},
    initBoard: async () => {},
    logger: silentLogger(),
  });

  assert.deepEqual(cloned, ['/abs/external/ext-reinstall']);
  assert.equal(result.command, `cd "${rel('/abs/external/ext-reinstall')}" && claude`);
  await rm(ws, { recursive: true, force: true });
});
```

- [x] **Step 2: Run the tests to verify the new ones fail**

Run: `npx nx test workspace-bootstrap`
Expected: all four new tests FAIL — `checkout` currently always resolves to `path.join(ws, 'ext')`, so hooks/clone/worktree/reinstall all target a location under `ws` instead of `/abs/external/ext...`.

- [x] **Step 3: Implement the minimal change**

In `libs/workspace-bootstrap/src/bootstrap.js`, change the initial checkout computation (currently line 75):

```js
    let checkout = path.join(workspaceDir, repo.name);
```
to:
```js
    let checkout = repo.path ? path.resolve(repo.path) : path.join(workspaceDir, repo.name);
```

Then, in the "existing checkout, not reusing" branch (currently lines 86-88):

```js
      } else {
        const suffix = action === 'reinstall' ? 'reinstall' : timestamp();
        checkout = path.join(workspaceDir, `${repo.name}-${suffix}`);
```
change to:
```js
      } else {
        const baseDir = path.dirname(checkout);
        const suffix = action === 'reinstall' ? 'reinstall' : timestamp();
        checkout = path.join(baseDir, `${repo.name}-${suffix}`);
```

Then, in the worktree block (currently line 105):

```js
      const wt = path.join(workspaceDir, `${repo.name}.${worktree.replace(/\//g, '-')}`);
```
change to:
```js
      const wt = path.join(path.dirname(checkout), `${repo.name}.${worktree.replace(/\//g, '-')}`);
```

None of these three changes affect existing `wk/`-based repos: `path.dirname(path.join(workspaceDir, repo.name))` is always `workspaceDir`, so the reinstall/timestamp and worktree locations are byte-identical to today when `repo.path` is absent.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, all tests (new and pre-existing) green, 100% coverage gate satisfied.

- [ ] **Step 5: Commit**

```bash
git add libs/workspace-bootstrap/src/bootstrap.js libs/workspace-bootstrap/test/bootstrap.test.js
git commit -m "feat(workspace-bootstrap): track repos at an external path instead of cloning into the workspace"
```

---

### Task 3: Document the `path` field in the README

**Files:**
- Modify: `README.md:26-31` (Configuration section bullets)
- Modify: `README.md:95-98` (Status tracking section)

- [x] **Step 1: Add the `path` field to the Configuration bullet list**

In `README.md`, after the `url` bullet (line 31):

```markdown
- `repos` (required): non-empty array. Each repo needs `name`, `url`, and a
  non-empty `technologies` array (matched against `skills/<techno>/`).
- `targets`: per-repo list of output formats. Falls back to `defaultTargets`
  when omitted. Known targets: `claude`, `copilot`, `cursor`, `windsurf`.
- `url`: SSH and scp-style URLs (`git@host:org/repo.git`, `ssh://…`) are
  rewritten to HTTPS automatically before cloning.
```
becomes:
```markdown
- `repos` (required): non-empty array. Each repo needs `name`, `url`, and a
  non-empty `technologies` array (matched against `skills/<techno>/`).
- `targets`: per-repo list of output formats. Falls back to `defaultTargets`
  when omitted. Known targets: `claude`, `copilot`, `cursor`, `windsurf`.
- `url`: SSH and scp-style URLs (`git@host:org/repo.git`, `ssh://…`) are
  rewritten to HTTPS automatically before cloning.
- `path`: optional absolute path to an existing local checkout. When set,
  `ai-workspace bootstrap` wires up status tracking, hooks, and dependency
  install there instead of cloning into the `--workspace` folder (cloning
  straight into `path` first if it doesn't exist yet). Only consumed by
  `ai-workspace`; `ai-sync` (the skill-push CLI) always clones into its own
  temporary work dir regardless.
```

- [x] **Step 2: Note external repos in the Status tracking section**

In `README.md`, the paragraph:

```markdown
The board is seeded (`todo` for every repo) at bootstrap and updated atomically.
Hook install and seeding are skipped on `--dry-run`. Only repos listed in the
config are tracked — a directory you create under the workspace by hand gets no
hooks and never appears on the board.
```
becomes:
```markdown
The board is seeded (`todo` for every repo) at bootstrap and updated atomically.
Hook install and seeding are skipped on `--dry-run`. Only repos listed in the
config are tracked — a directory you create under the workspace by hand gets no
hooks and never appears on the board. A repo can also point at an existing
checkout **outside** the workspace via `path` (see [Configuration](#configuration))
— it's tracked on the same board exactly like a repo cloned into the workspace.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the optional per-repo path field"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (config schema) → Task 1. Section 2 (bootstrap checkout/worktree logic) → Task 2 (worktree placement change is spec'd explicitly; the reinstall/timestamp placement fix in Task 2 Step 3 is a direct, same-rationale extension — otherwise interactively choosing "reinstall"/"timestamp" on a path-based repo would silently abandon its external location and re-clone into `workspaceDir`, contradicting the whole feature). Section 3 (docs) → Task 3. Out-of-scope items (auto-detection, board UI path display, config-parse-time path validation) are intentionally absent.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `repo.path` is the field name used consistently in `config.js`, `bootstrap.js`, tests, and docs; `checkout`, `boardPath`, `workDir`, `wt` variable names match `bootstrap.js`'s existing naming.
