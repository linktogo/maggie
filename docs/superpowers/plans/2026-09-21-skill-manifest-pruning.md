# Skill Manifest Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** `maggie`'s sync pipeline deletes rendered files a repo's current config no longer produces (a renamed skill, a dropped technology, a dropped target), instead of leaving them behind forever — tracked via a small `.maggie/manifest.json` committed alongside the skill files, with a safety net against wiping a repo's files when a config mistake makes its render come back empty.

**Architecture:** A new, dependency-free module, `libs/skill-sync/src/manifest.js`, owns reading/writing the manifest and computing the stale-path diff — no git or rendering knowledge. `libs/skill-sync/src/pipeline.js`'s `syncRepo` reads the old manifest right after cloning (before switching to the throwaway sync branch), writes the new files as it already does, then deletes whatever the old manifest listed that the new render doesn't, and writes the new manifest — except when the new render is completely empty against a non-empty old manifest, where it does neither and warns instead.

**Tech Stack:** Node.js (`node:test`, `node --experimental-test-coverage`, `node:fs/promises`). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-21-skill-manifest-pruning-design.md`](../specs/2026-09-21-skill-manifest-pruning-design.md)

---

### Task 1: `manifest.js` — read, write, and diff

**Files:**
- Create: `libs/skill-sync/src/manifest.js`
- Test: `libs/skill-sync/test/manifest.test.js`

This is a brand-new module and test file — no existing content to reconcile against.

- [x] **Step 1: Write the failing tests**

Create `libs/skill-sync/test/manifest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, stalePaths } from '../src/manifest.js';

test('readManifest returns an empty manifest when the file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: [] });
});

test('readManifest returns the parsed paths when the file is valid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(
    path.join(dir, '.maggie/manifest.json'),
    JSON.stringify({ version: 1, paths: ['b.md', 'a.md'] }),
  );
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: ['b.md', 'a.md'] });
});

test('readManifest treats invalid JSON as no manifest and warns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), '{ not json');
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON, treating as no manifest/);
});

test('readManifest rethrows non-ENOENT filesystem errors (e.g. ENOTDIR when .maggie is a file)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeFile(path.join(dir, '.maggie'), 'not a directory');
  await assert.rejects(() => readManifest(dir), (err) => err.code !== 'ENOENT');
});

test('writeManifest writes a sorted paths array under the schema version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeManifest(dir, ['z.md', 'a.md', 'm.md']);
  const raw = await readFile(path.join(dir, '.maggie/manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, paths: ['a.md', 'm.md', 'z.md'] });
});

test('writeManifest creates the .maggie directory if it does not exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeManifest(dir, []);
  const raw = await readFile(path.join(dir, '.maggie/manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, paths: [] });
});

test('stalePaths returns entries in oldPaths absent from newPaths', () => {
  assert.deepEqual(stalePaths(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

test('stalePaths returns an empty array when nothing is stale', () => {
  assert.deepEqual(stalePaths(['a', 'b'], ['a', 'b', 'c']), []);
});

test('stalePaths returns everything when newPaths is empty', () => {
  assert.deepEqual(stalePaths(['a', 'b'], []), ['a', 'b']);
});
```

- [x] **Step 2: Run and confirm it fails**

Run: `cd libs/skill-sync && node --test test/manifest.test.js`

Expected: fails immediately with a module-not-found error (`Cannot find module '../src/manifest.js'` or similar) — `manifest.js` doesn't exist yet.

- [x] **Step 3: Implement**

Create `libs/skill-sync/src/manifest.js`:

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_PATH = '.maggie/manifest.json';
const SCHEMA_VERSION = 1;

export async function readManifest(dir, { warn = console.warn } = {}) {
  const file = path.join(dir, MANIFEST_PATH);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: SCHEMA_VERSION, paths: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? SCHEMA_VERSION,
      paths: Array.isArray(parsed.paths) ? parsed.paths : [],
    };
  } catch (err) {
    warn(`${file}: invalid JSON, treating as no manifest (${err.message})`);
    return { version: SCHEMA_VERSION, paths: [] };
  }
}

export async function writeManifest(dir, paths) {
  const full = path.join(dir, MANIFEST_PATH);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `${JSON.stringify({ version: SCHEMA_VERSION, paths: [...paths].sort() }, null, 2)}\n`);
}

export function stalePaths(oldPaths, newPaths) {
  const newSet = new Set(newPaths);
  return oldPaths.filter((p) => !newSet.has(p));
}
```

- [x] **Step 4: Run and confirm it passes**

Run: `cd libs/skill-sync && node --test test/manifest.test.js`

Expected: all 9 tests pass.

- [x] **Step 5: Run with coverage**

Run:
```bash
cd libs/skill-sync
node --test --experimental-test-coverage --test-coverage-include="src/**/*.js" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 "test/**/*.test.js"
```

Expected: all tests across the whole `skill-sync` package pass (pipeline.test.js, skill.test.js, skills.test.js, manifest.test.js), and `manifest.js` shows 100.00% line/branch/function coverage. `pipeline.js` is untouched by this task, so its coverage is unaffected.

- [x] **Step 6: Commit**

```bash
git add libs/skill-sync/src/manifest.js libs/skill-sync/test/manifest.test.js
git commit -m "feat(skill-sync): add a manifest module to read, write, and diff rendered paths"
```

Do not push. Do not touch `pipeline.js` or `pipeline.test.js` — that's the next task.

---

### Task 2: Wire pruning into the sync pipeline

**Files:**
- Modify: `libs/skill-sync/src/pipeline.js`
- Modify: `libs/skill-sync/test/pipeline.test.js`

Depends on Task 1 (`manifest.js` must exist).

Current `libs/skill-sync/src/pipeline.js`:

```js
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { clone as defaultClone } from '@linktogo/maggie-git';
import { resolveSkills as defaultResolveSkills } from './skills.js';
import { getRenderer as defaultGetRenderer } from '@linktogo/maggie-renderers';

const BRANCH = 'maggie/update-skills';
const COMMIT_MESSAGE = 'chore: sync AI agent skills';
const PR_TITLE = 'Sync AI agent skills';
const PR_BODY = 'Automated skill sync from maggie.';

export async function run(config, options = {}) {
  const {
    skillsDir,
    workDir,
    pr = false,
    dryRun = false,
    strict = false,
    repoFilter,
    clone = defaultClone,
    resolveSkills = defaultResolveSkills,
    getRenderer = defaultGetRenderer,
    logger = console,
  } = options;

  const repos = repoFilter
    ? config.repos.filter((repo) => repo.name === repoFilter)
    : config.repos;

  const results = [];
  for (const repo of repos) {
    try {
      results.push(await syncRepo(repo, {
        skillsDir, workDir, pr, dryRun, strict, clone, resolveSkills, getRenderer, logger,
      }));
    } catch (err) {
      logger.error(`✗ ${repo.name}: ${err.message}`);
      results.push({ repo: repo.name, status: 'error', error: err.message });
    }
  }

  report(results, logger);
  return results;
}

async function syncRepo(repo, ctx) {
  const { skillsDir, workDir, pr, dryRun, strict, clone, resolveSkills, getRenderer, logger } = ctx;
  const skills = await resolveSkills(skillsDir, repo.technologies, {
    warn: (m) => logger.warn(m),
    strict,
  });

  if (skills.length === 0) {
    const message = `${repo.name}: no skills resolved for technologies [${repo.technologies.join(', ')}]`;
    if (strict) throw new Error(message);
    logger.warn(message);
  }

  const files = [];
  for (const skill of skills) {
    for (const target of repo.targets) {
      files.push(getRenderer(target).render(skill));
    }
  }

  if (dryRun) {
    for (const file of files) logger.log(`[dry-run] ${repo.name}: ${file.path}`);
    return { repo: repo.name, status: 'dry-run', files: files.length };
  }

  const dest = path.join(workDir, repo.name);
  await rm(dest, { recursive: true, force: true });
  const gitRepo = await clone(repo.url, dest);
  await gitRepo.checkoutBranch(BRANCH);

  for (const file of files) {
    const full = path.join(dest, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }

  if (!(await gitRepo.hasChanges())) {
    logger.log(`= ${repo.name}: no changes`);
    return { repo: repo.name, status: 'skipped', files: files.length };
  }

  await gitRepo.commitAll(COMMIT_MESSAGE);
  await gitRepo.push(BRANCH, { force: true });
  if (pr) await gitRepo.createPR(PR_TITLE, PR_BODY);

  logger.log(`✓ ${repo.name}: ${files.length} files pushed${pr ? ' + PR' : ''}`);
  return { repo: repo.name, status: pr ? 'pr' : 'pushed', files: files.length };
}

function report(results, logger) {
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  logger.log(`\nSummary: ${JSON.stringify(counts)}`);
}
```

Current `libs/skill-sync/test/pipeline.test.js` starts:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/pipeline.js';
```

and defines `fakeCloneFactory`, `config`, `skill` (with `source: 'skills/nestjs/s/SKILL.md'`), and `resolveSkills` exactly as left by the prior plan. If either file's current content differs meaningfully from what's shown here, stop and reconcile before proceeding.

- [x] **Step 1: Write the three new failing tests**

First, update the import line at the top of `libs/skill-sync/test/pipeline.test.js` — change:

```js
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
```

to:

```js
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
```

Then append these three tests at the end of the file (after the existing last test, `'repoFilter restricts processing to one repo'`):

```js
test('prunes a file the new render no longer produces and rewrites the manifest', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const clone = async (url, dir) => {
    await mkdir(path.join(dir, '.maggie'), { recursive: true });
    await writeFile(
      path.join(dir, '.maggie/manifest.json'),
      JSON.stringify({ version: 1, paths: ['.claude/skills/s/SKILL.md', '.claude/skills/stale-skill/SKILL.md'] }),
    );
    await mkdir(path.join(dir, '.claude/skills/stale-skill'), { recursive: true });
    await writeFile(path.join(dir, '.claude/skills/stale-skill/SKILL.md'), 'old content');
    return fakeCloneFactory(state)(url, dir);
  };
  const results = await run(config, {
    skillsDir: 'irrelevant', workDir, resolveSkills,
    clone, logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pushed');
  await assert.rejects(
    () => readFile(path.join(workDir, 'a', '.claude/skills/stale-skill/SKILL.md')),
    (err) => err.code === 'ENOENT',
  );
  const manifest = JSON.parse(await readFile(path.join(workDir, 'a', '.maggie/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/s/SKILL.md'] });
});

test('writes a manifest for the first time when the repo has none yet', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(config, {
    skillsDir: 'irrelevant', workDir, resolveSkills,
    clone: fakeCloneFactory(state), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pushed');
  const manifest = JSON.parse(await readFile(path.join(workDir, 'a', '.maggie/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/s/SKILL.md'] });
});

test('skips pruning and leaves the manifest untouched when the new render is empty but the old manifest was not', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  const clone = async (url, dir) => {
    await mkdir(path.join(dir, '.maggie'), { recursive: true });
    await writeFile(
      path.join(dir, '.maggie/manifest.json'),
      JSON.stringify({ version: 1, paths: ['.claude/skills/old-skill/SKILL.md'] }),
    );
    await mkdir(path.join(dir, '.claude/skills/old-skill'), { recursive: true });
    await writeFile(path.join(dir, '.claude/skills/old-skill/SKILL.md'), 'still here');
    return fakeCloneFactory(state)(url, dir);
  };
  const warnings = [];
  const results = await run(config, {
    skillsDir: 'irrelevant', workDir, resolveSkills: async () => [],
    clone, logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.equal(results[0].status, 'skipped');
  const stillThere = await readFile(path.join(workDir, 'a', '.claude/skills/old-skill/SKILL.md'), 'utf8');
  assert.equal(stillThere, 'still here');
  const manifest = JSON.parse(await readFile(path.join(workDir, 'a', '.maggie/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/old-skill/SKILL.md'] });
  assert.ok(warnings.some((w) => /new render is empty but 1 file\(s\) were previously tracked/.test(w)));
});
```

- [x] **Step 2: Run the suite and confirm the right things fail**

Run: `cd libs/skill-sync && node --test test/pipeline.test.js`

Expected: the 10 pre-existing tests still pass. The 3 new tests FAIL:
- `'prunes a file...'` fails because `.claude/skills/stale-skill/SKILL.md` still exists (nothing deletes it yet) and/or `.maggie/manifest.json` was never written.
- `'writes a manifest for the first time...'` fails because `readFile(path.join(workDir, 'a', '.maggie/manifest.json'), 'utf8')` rejects with `ENOENT` — no manifest is written yet.
- `'skips pruning...'` fails for the same reason (no manifest is ever written, so the read at the end rejects) — note this test's *outcome* should end up passing once implemented, but today it fails because nothing writes a manifest at all yet, not because of any different bug.

- [x] **Step 3: Implement**

Replace `libs/skill-sync/src/pipeline.js` with:

```js
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { clone as defaultClone } from '@linktogo/maggie-git';
import { resolveSkills as defaultResolveSkills } from './skills.js';
import { getRenderer as defaultGetRenderer } from '@linktogo/maggie-renderers';
import { readManifest as defaultReadManifest, writeManifest as defaultWriteManifest, stalePaths } from './manifest.js';

const BRANCH = 'maggie/update-skills';
const COMMIT_MESSAGE = 'chore: sync AI agent skills';
const PR_TITLE = 'Sync AI agent skills';
const PR_BODY = 'Automated skill sync from maggie.';

export async function run(config, options = {}) {
  const {
    skillsDir,
    workDir,
    pr = false,
    dryRun = false,
    strict = false,
    repoFilter,
    clone = defaultClone,
    resolveSkills = defaultResolveSkills,
    getRenderer = defaultGetRenderer,
    readManifest = defaultReadManifest,
    writeManifest = defaultWriteManifest,
    logger = console,
  } = options;

  const repos = repoFilter
    ? config.repos.filter((repo) => repo.name === repoFilter)
    : config.repos;

  const results = [];
  for (const repo of repos) {
    try {
      results.push(await syncRepo(repo, {
        skillsDir, workDir, pr, dryRun, strict, clone, resolveSkills, getRenderer,
        readManifest, writeManifest, logger,
      }));
    } catch (err) {
      logger.error(`✗ ${repo.name}: ${err.message}`);
      results.push({ repo: repo.name, status: 'error', error: err.message });
    }
  }

  report(results, logger);
  return results;
}

async function syncRepo(repo, ctx) {
  const {
    skillsDir, workDir, pr, dryRun, strict, clone, resolveSkills, getRenderer,
    readManifest, writeManifest, logger,
  } = ctx;
  const skills = await resolveSkills(skillsDir, repo.technologies, {
    warn: (m) => logger.warn(m),
    strict,
  });

  if (skills.length === 0) {
    const message = `${repo.name}: no skills resolved for technologies [${repo.technologies.join(', ')}]`;
    if (strict) throw new Error(message);
    logger.warn(message);
  }

  const files = [];
  for (const skill of skills) {
    for (const target of repo.targets) {
      files.push(getRenderer(target).render(skill));
    }
  }

  if (dryRun) {
    for (const file of files) logger.log(`[dry-run] ${repo.name}: ${file.path}`);
    return { repo: repo.name, status: 'dry-run', files: files.length };
  }

  const dest = path.join(workDir, repo.name);
  await rm(dest, { recursive: true, force: true });
  const gitRepo = await clone(repo.url, dest);
  const oldManifest = await readManifest(dest, { warn: (m) => logger.warn(m) });
  await gitRepo.checkoutBranch(BRANCH);

  for (const file of files) {
    const full = path.join(dest, file.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }

  const newPaths = files.map((file) => file.path);
  if (newPaths.length === 0 && oldManifest.paths.length > 0) {
    logger.warn(
      `${repo.name}: new render is empty but ${oldManifest.paths.length} file(s) were previously tracked` +
      ' — skipping prune and leaving the manifest untouched (check repo.technologies)',
    );
  } else {
    const stale = stalePaths(oldManifest.paths, newPaths);
    for (const staleFile of stale) {
      await rm(path.join(dest, staleFile), { force: true });
      logger.log(`- ${repo.name}: pruning ${staleFile}`);
    }
    await writeManifest(dest, newPaths);
  }

  if (!(await gitRepo.hasChanges())) {
    logger.log(`= ${repo.name}: no changes`);
    return { repo: repo.name, status: 'skipped', files: files.length };
  }

  await gitRepo.commitAll(COMMIT_MESSAGE);
  await gitRepo.push(BRANCH, { force: true });
  if (pr) await gitRepo.createPR(PR_TITLE, PR_BODY);

  logger.log(`✓ ${repo.name}: ${files.length} files pushed${pr ? ' + PR' : ''}`);
  return { repo: repo.name, status: pr ? 'pr' : 'pushed', files: files.length };
}

function report(results, logger) {
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  logger.log(`\nSummary: ${JSON.stringify(counts)}`);
}
```

- [x] **Step 4: Run and confirm everything passes**

Run: `cd libs/skill-sync && node --test test/pipeline.test.js`

Expected: all 13 tests pass (10 pre-existing + 3 new).

- [x] **Step 5: Run the whole package with coverage**

Run:
```bash
cd libs/skill-sync
node --test --experimental-test-coverage --test-coverage-include="src/**/*.js" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 "test/**/*.test.js"
```

Expected: all tests pass (manifest.test.js's 9 + pipeline.test.js's 13 + skill.test.js's + skills.test.js's), and 100.00% line/branch/function coverage on every file in `src/`, including `pipeline.js` and `manifest.js`. If `pipeline.js` shows an uncovered branch on the `newPaths.length === 0 && oldManifest.paths.length > 0` condition or the `for (const staleFile of stale)` loop, check that all three new tests ran — each new test exercises a different branch combination and the loop's non-empty case.

- [x] **Step 6: Commit**

```bash
git add libs/skill-sync/src/pipeline.js libs/skill-sync/test/pipeline.test.js
git commit -m "feat(skill-sync): prune rendered files the current sync no longer produces"
```

Do not push yet.

---

### Task 3: Document pruning in `docs/sync-cli.md`

**Files:**
- Modify: `docs/sync-cli.md`

No test — this is documentation only.

Current `docs/sync-cli.md` "What a run does" section:

```markdown
## What a run does

For each repo in the [config](configuration.md):

1. Clone it into a temporary work dir (`--work-dir` to choose the parent).
2. Resolve the skills matching the repo's `technologies`.
3. Render each skill for each of the repo's `targets`.
4. Check out `maggie/update-skills`, write the files, commit, force-push.
5. Optionally open a PR with `gh` (`--pr`).

The branch is rewritten on every sync — it is a throwaway output branch, not a
place to commit by hand.
```

If this differs from the file's current content, reconcile before proceeding.

- [x] **Step 1: Replace the section**

Replace the block above with:

```markdown
## What a run does

For each repo in the [config](configuration.md):

1. Clone it into a temporary work dir (`--work-dir` to choose the parent).
2. Resolve the skills matching the repo's `technologies`.
3. Render each skill for each of the repo's `targets`.
4. Check out `maggie/update-skills`, write the files, prune what the current
   render no longer produces, commit, force-push.
5. Optionally open a PR with `gh` (`--pr`).

The branch is rewritten on every sync — it is a throwaway output branch, not a
place to commit by hand.

### Pruning stale files

Renamed a skill, dropped a technology, or dropped a target from a repo's
`targets`, and the file that used to render is now stale — a run deletes it,
rather than leaving it behind forever. This is tracked in a small manifest,
`.maggie/manifest.json`, committed alongside the skill files: every path the
last run wrote, so the next run can tell "no longer rendered" apart from
"never touched." A repo with no manifest yet (from before this existed, or a
first sync) gets one written and nothing pruned — the run after that is
where pruning starts.

If every technology in a repo's config fails to resolve any skill — a typo, a
moved skills library — the render for that repo is empty. Rather than reading
that as "delete everything this repo ever had," a run leaves both the files
and the manifest untouched and warns loudly instead: an empty render is far
more likely to be a config mistake than an instruction to wipe a repo.
```

- [x] **Step 2: Verify**

Run: `sed -n '1,40p' docs/sync-cli.md`

Expected: the "What a run does" list shows the updated step 4, followed immediately by the new "### Pruning stale files" subsection, followed by whatever section originally came next in the file (the flags table).

- [x] **Step 3: Commit**

```bash
git add docs/sync-cli.md
git commit -m "docs(sync-cli): document skill-manifest pruning"
```

Do not push yet.

---

### Task 4: Full-repo verification and push

**Files:** none (verification only)

- [x] **Step 1: Run the skill-sync suite fresh, bypassing Nx's cache**

```bash
cd /home/user/maggie
npx nx run skill-sync:test --skip-nx-cache
```

Expected: all tests pass, 100.00% line/branch/function coverage on every file in `libs/skill-sync/src/`.

- [x] **Step 2: Run the full monorepo suite**

```bash
npm test
```

Expected: all 11 projects pass — nothing outside `skill-sync` should be affected, but this confirms it.

- [x] **Step 3: Lint**

```bash
npx nx run skill-sync:lint --skip-nx-cache
```

Expected: clean, no errors.

- [x] **Step 4: Manual end-to-end sanity check of a pruning run**

```bash
cd /home/user/maggie
node -e "
import('node:fs/promises').then(async ({ mkdtemp, mkdir, writeFile, readFile, rm }) => {
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { run } = await import('./libs/skill-sync/src/pipeline.js');

  const workDir = await mkdtemp(path.join(tmpdir(), 'manual-check-'));
  const config = { defaultTargets: ['claude'], repos: [{ name: 'demo', url: 'u', technologies: ['nestjs'], targets: ['claude'] }] };
  const skill = { name: 'nestjs-module-structure', description: 'D', body: '# B', source: 'skills/nestjs/module-structure/SKILL.md' };

  const state = { hasChanges: true };
  const clone = async (url, dir) => {
    await mkdir(path.join(dir, '.maggie'), { recursive: true });
    await writeFile(path.join(dir, '.maggie/manifest.json'), JSON.stringify({ version: 1, paths: ['.claude/skills/old-thing/SKILL.md'] }));
    await mkdir(path.join(dir, '.claude/skills/old-thing'), { recursive: true });
    await writeFile(path.join(dir, '.claude/skills/old-thing/SKILL.md'), 'stale');
    return {
      dir,
      async checkoutBranch() {}, async hasChanges() { return state.hasChanges; },
      async commitAll() {}, async push() {}, async createPR() {},
    };
  };

  await run(config, {
    skillsDir: 'irrelevant', workDir, resolveSkills: async () => [skill],
    clone, logger: console,
  });

  const manifest = await readFile(path.join(workDir, 'demo', '.maggie/manifest.json'), 'utf8');
  console.log('manifest:', manifest);
  const oldStillThere = await readFile(path.join(workDir, 'demo', '.claude/skills/old-thing/SKILL.md'), 'utf8').then(() => true).catch(() => false);
  console.log('stale file still present:', oldStillThere);
});
"
```

Expected: log output shows a line like `- demo: pruning .claude/skills/old-thing/SKILL.md`, the printed manifest is `{"version":1,"paths":[".claude/skills/nestjs-module-structure/SKILL.md"]}` (only the current render), and `stale file still present: false`.

- [x] **Step 5: Push**

```bash
git push -u origin claude/project-feature-proposals-nsegpl
```

---

## Self-Review Notes

- **Spec coverage:** `.maggie/manifest.json` format with schema version (not tool version) ✓ Task 1, read-before-checkout ordering ✓ Task 2 Step 3, missing-manifest-is-not-an-error migration path ✓ Task 1's `readManifest` + Task 2's "writes a manifest for the first time" test, corrupt-manifest-is-treated-as-missing-with-a-warning ✓ Task 1, the empty-render safety net (no delete, no manifest overwrite, loud warning) ✓ Task 2, dry-run unaffected ✓ (no change needed — the dry-run branch returns before any of the new code runs, and no test needed to change to prove that since it already returns early), documentation ✓ Task 3.
- **Type consistency:** `readManifest(dir, { warn })` / `writeManifest(dir, paths)` / `stalePaths(oldPaths, newPaths)` signatures are defined once in Task 1 and used identically in Task 2's `pipeline.js`; `oldManifest.paths` / `newPaths` naming is consistent between the design, the implementation, and the tests.
- **No placeholders:** every step shows exact before/after file content or an exact command with its expected output.
