# npm Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate patch/minor version bumps and release-note generation for the six lockstep npm packages, keep major bumps as an explicit manual action, and gate the actual `npm publish` step to the `lk-publish` GitHub team at two independent checkpoints.

**Architecture:** Two small standalone Node scripts (`scripts/bump-version.js`, `scripts/detect-bump-type.js`) do the version/changelog math and commit-message classification; a third (`scripts/extract-changelog-section.js`) pulls one version's notes out of `CHANGELOG.md`. Three GitHub Actions workflows wire them together: `prepare-release.yml` (auto-opens a version-bump PR from commits on `main`), `release.yml` (tag push → GitHub Release with auto-extracted notes), and the existing `publish.yml` (Release published → npm publish, now behind an `lk-publish`-reviewed environment). An operator-run shell script configures the two GitHub-side gates (tag ruleset, environment reviewers) once the `lk-publish` team exists.

**Tech Stack:** Plain Node.js (`node:test`, `node:child_process`, `node:fs`), no new npm dependencies except the `peter-evans/create-pull-request` GitHub Action.

**Spec:** `docs/superpowers/specs/2026-08-10-npm-release-automation-design.md`

---

## File Structure

| File | Purpose |
|---|---|
| `scripts/bump-version.js` (new) | Bumps root + 5 `libs/*` versions, updates internal `@linktogo/ai-*` ranges everywhere, moves `CHANGELOG.md`'s `Unreleased` section under a new version heading. CLI: `node scripts/bump-version.js <major\|minor\|patch> [--dry-run]`. |
| `scripts/bump-version.test.js` (new) | `node:test` coverage for the above. |
| `scripts/detect-bump-type.js` (new) | Classifies commits since the last tag into `patch`/`minor`/`none` + a `breaking` flag; also detects "a release is already pending" to avoid double-bumping. CLI prints `type=...` / `breaking=...` for `$GITHUB_OUTPUT`. |
| `scripts/detect-bump-type.test.js` (new) | `node:test` coverage, including real-git-temp-repo integration tests. |
| `scripts/extract-changelog-section.js` (new) | Pulls the `## [X.Y.Z]` section body out of `CHANGELOG.md` for use as a GitHub Release body. CLI: `node scripts/extract-changelog-section.js vX.Y.Z`. |
| `scripts/extract-changelog-section.test.js` (new) | `node:test` coverage. |
| `scripts/setup-release-protections.sh` (new) | One-time, operator-run `gh api` helper that configures the `npm-publish` environment and the `v*` tag ruleset once `lk-publish` exists. Not run by CI. |
| `package.json` (modify) | Add `"test:scripts": "node --test scripts/*.test.js"`. |
| `.github/workflows/ci.yml` (modify) | Run `npm run test:scripts` alongside the existing Nx test step. |
| `.github/workflows/prepare-release.yml` (new) | On push to `main`: detect bump type, run `bump-version.js`, open/update a release PR. |
| `.github/workflows/release.yml` (new) | On push of a `v*` tag: verify the tag matches `package.json`, extract changelog notes, create the GitHub Release. |
| `.github/workflows/publish.yml` (modify) | Add `environment: npm-publish` to the existing `publish` job — everything else unchanged. |
| `CONTRIBUTING.md` (modify) | Rewrite the "Releasing" section to describe the new flow. |

---

## Task 1: `scripts/bump-version.js`

**Files:**
- Create: `scripts/bump-version.js`
- Test: `scripts/bump-version.test.js`

- [ ] **Step 1: Write the failing test for `computeNextVersion`**

```js
// scripts/bump-version.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNextVersion,
  listWorkspaceManifests,
  bumpManifestVersion,
  updateInternalDependencyRanges,
  updateChangelog,
} from './bump-version.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

test('computeNextVersion bumps the right segment and zeroes the rest', () => {
  assert.equal(computeNextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(computeNextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(computeNextVersion('1.2.3', 'patch'), '1.2.4');
});

test('computeNextVersion rejects an unknown bump type', () => {
  assert.throws(() => computeNextVersion('1.2.3', 'banana'), /Unknown bump type/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — `./bump-version.js` does not exist yet.

- [ ] **Step 3: Create `scripts/bump-version.js` with `computeNextVersion`**

```js
// scripts/bump-version.js
#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/linktogo/ai-sync';

export function computeNextVersion(currentVersion, bumpType) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  if (bumpType === 'major') return `${major + 1}.0.0`;
  if (bumpType === 'minor') return `${major}.${minor + 1}.0`;
  if (bumpType === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump type: ${bumpType}`);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for `listWorkspaceManifests`**

```js
// append to scripts/bump-version.test.js
test('listWorkspaceManifests finds root, libs, and apps package.json files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await mkdir(path.join(root, 'libs', 'b'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'c'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'b', 'package.json'), '{}');
  await writeFile(path.join(root, 'apps', 'c', 'package.json'), '{}');

  const { versioned, all } = listWorkspaceManifests(root);

  assert.deepEqual(
    versioned.sort(),
    [
      path.join(root, 'package.json'),
      path.join(root, 'libs', 'a', 'package.json'),
      path.join(root, 'libs', 'b', 'package.json'),
    ].sort(),
  );
  assert.deepEqual(
    all.sort(),
    [
      path.join(root, 'package.json'),
      path.join(root, 'libs', 'a', 'package.json'),
      path.join(root, 'libs', 'b', 'package.json'),
      path.join(root, 'apps', 'c', 'package.json'),
    ].sort(),
  );
});

test('listWorkspaceManifests tolerates a missing apps directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{}');

  const { all } = listWorkspaceManifests(root);

  assert.deepEqual(all.sort(), [
    path.join(root, 'package.json'),
    path.join(root, 'libs', 'a', 'package.json'),
  ].sort());
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — `listWorkspaceManifests` is not exported.

- [ ] **Step 7: Implement `listWorkspaceManifests`**

```js
// add to scripts/bump-version.js, after computeNextVersion
function readManifestDirs(base) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name, 'package.json'));
}

export function listWorkspaceManifests(repoRoot) {
  const libs = readManifestDirs(path.join(repoRoot, 'libs'));
  const apps = readManifestDirs(path.join(repoRoot, 'apps'));
  const root = path.join(repoRoot, 'package.json');
  return { versioned: [root, ...libs], all: [root, ...libs, ...apps] };
}
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (4 tests)

- [ ] **Step 9: Write the failing test for `bumpManifestVersion`**

```js
// append to scripts/bump-version.test.js
test('bumpManifestVersion updates only the version field', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  await writeFile(
    file,
    JSON.stringify({ name: 'x', version: '1.2.3', dependencies: { y: '^1.0.0' } }, null, 2) + '\n',
  );

  bumpManifestVersion(file, '1.3.0');

  const pkg = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pkg.version, '1.3.0');
  assert.equal(pkg.name, 'x');
  assert.deepEqual(pkg.dependencies, { y: '^1.0.0' });
});
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — `bumpManifestVersion` is not exported.

- [ ] **Step 11: Implement `bumpManifestVersion`**

```js
// add to scripts/bump-version.js
export function bumpManifestVersion(filePath, newVersion) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
}
```

- [ ] **Step 12: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (5 tests)

- [ ] **Step 13: Write the failing tests for `updateInternalDependencyRanges`**

```js
// append to scripts/bump-version.test.js
test('updateInternalDependencyRanges bumps only @linktogo/ai-* deps', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  await writeFile(
    file,
    JSON.stringify(
      { name: 'x', version: '1.2.3', dependencies: { '@linktogo/ai-git': '^1.2.3', 'gray-matter': '^4.0.3' } },
      null,
      2,
    ) + '\n',
  );

  updateInternalDependencyRanges(file, '1.3.0');

  const pkg = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pkg.dependencies['@linktogo/ai-git'], '^1.3.0');
  assert.equal(pkg.dependencies['gray-matter'], '^4.0.3');
});

test('updateInternalDependencyRanges is a no-op when there are no dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  const original = JSON.stringify({ name: 'x', version: '1.2.3' }, null, 2) + '\n';
  await writeFile(file, original);

  updateInternalDependencyRanges(file, '1.3.0');

  assert.equal(await readFile(file, 'utf8'), original);
});
```

- [ ] **Step 14: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — `updateInternalDependencyRanges` is not exported.

- [ ] **Step 15: Implement `updateInternalDependencyRanges`**

```js
// add to scripts/bump-version.js
export function updateInternalDependencyRanges(filePath, newVersion) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  const deps = pkg.dependencies;
  if (!deps) return;
  let changed = false;
  for (const name of Object.keys(deps)) {
    if (!name.startsWith('@linktogo/ai-')) continue;
    const next = `^${newVersion}`;
    if (deps[name] !== next) {
      deps[name] = next;
      changed = true;
    }
  }
  if (changed) writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
}
```

- [ ] **Step 16: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (7 tests)

- [ ] **Step 17: Write the failing tests for `updateChangelog`**

```js
// append to scripts/bump-version.test.js
test('updateChangelog moves Unreleased under a new version heading and updates links', () => {
  const input = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- Something new.',
    '',
    '## [0.1.0]',
    '',
    'Initial release.',
    '',
    '[Unreleased]: https://github.com/linktogo/ai-sync/compare/v0.1.0...HEAD',
    '[0.1.0]: https://github.com/linktogo/ai-sync/releases/tag/v0.1.0',
    '',
  ].join('\n');

  const out = updateChangelog(input, { oldVersion: '0.1.0', newVersion: '0.2.0', date: '2026-08-10' });

  assert.match(out, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-08-10\n\n### Added/);
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/linktogo\/ai-sync\/compare\/v0\.2\.0\.\.\.HEAD/);
  assert.match(out, /\[0\.2\.0\]: https:\/\/github\.com\/linktogo\/ai-sync\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.match(out, /\[0\.1\.0\]: https:\/\/github\.com\/linktogo\/ai-sync\/releases\/tag\/v0\.1\.0/);
});

test('updateChangelog falls back to a releases/tag link when there is no prior version link', () => {
  const input = [
    '## [Unreleased]',
    '',
    '- First entry.',
    '',
    '[Unreleased]: https://github.com/linktogo/ai-sync/compare/v0.1.0...HEAD',
    '',
  ].join('\n');

  const out = updateChangelog(input, { oldVersion: '0.1.0', newVersion: '0.2.0', date: '2026-08-10' });

  assert.match(out, /\[0\.2\.0\]: https:\/\/github\.com\/linktogo\/ai-sync\/releases\/tag\/v0\.2\.0/);
});
```

- [ ] **Step 18: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — `updateChangelog` is not exported.

- [ ] **Step 19: Implement `updateChangelog`**

```js
// add to scripts/bump-version.js
export function updateChangelog(changelogText, { oldVersion, newVersion, date, repoUrl = REPO_URL }) {
  const heading = '## [Unreleased]';
  const idx = changelogText.indexOf(heading);
  if (idx === -1) throw new Error('CHANGELOG.md has no [Unreleased] section');
  const insertAt = idx + heading.length;
  const withHeading =
    changelogText.slice(0, insertAt) + `\n\n## [${newVersion}] - ${date}` + changelogText.slice(insertAt);

  const unreleasedLinkRe = /^\[Unreleased\]: .*$/m;
  const oldVersionLinkRe = new RegExp(`^\\[${oldVersion.replace(/\./g, '\\.')}\\]: .*$`, 'm');
  const newUnreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD`;
  const newVersionLink = oldVersionLinkRe.test(withHeading)
    ? `[${newVersion}]: ${repoUrl}/compare/v${oldVersion}...v${newVersion}`
    : `[${newVersion}]: ${repoUrl}/releases/tag/v${newVersion}`;

  return withHeading.replace(unreleasedLinkRe, `${newUnreleasedLink}\n${newVersionLink}`);
}
```

- [ ] **Step 20: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (9 tests)

- [ ] **Step 21: Write the failing test for the CLI's `--dry-run` mode**

```js
// append to scripts/bump-version.test.js
test('CLI dry-run reports the computed bump without writing any file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await copyFile(path.join(SCRIPT_DIR, 'bump-version.js'), path.join(root, 'scripts', 'bump-version.js'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.2.3' }, null, 2));
  await writeFile(
    path.join(root, 'libs', 'a', 'package.json'),
    JSON.stringify({ name: 'a', version: '1.2.3' }, null, 2),
  );
  await writeFile(
    path.join(root, 'CHANGELOG.md'),
    '## [Unreleased]\n\n- x\n\n[Unreleased]: https://github.com/linktogo/ai-sync/compare/v1.2.3...HEAD\n',
  );

  const out = execFileSync('node', [path.join(root, 'scripts', 'bump-version.js'), 'minor', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.match(out, /1\.2\.3 -> 1\.3\.0/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '1.2.3');
});

test('CLI rejects a missing or invalid bump type', () => {
  assert.throws(() => execFileSync('node', [path.join(SCRIPT_DIR, 'bump-version.js')], { encoding: 'utf8' }));
});
```

- [ ] **Step 22: Run it to confirm it fails**

Run: `node --test scripts/bump-version.test.js`
Expected: FAIL — running the file today does nothing (no CLI wiring yet), so stdout is empty and the "Usage" test doesn't throw.

- [ ] **Step 23: Add the CLI wiring**

```js
// add to scripts/bump-version.js
function runCli() {
  const [bumpType, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  if (!['major', 'minor', 'patch'].includes(bumpType)) {
    console.error('Usage: node scripts/bump-version.js <major|minor|patch> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const rootPkgPath = path.join(REPO_ROOT, 'package.json');
  const currentVersion = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version;
  const newVersion = computeNextVersion(currentVersion, bumpType);
  const { versioned, all } = listWorkspaceManifests(REPO_ROOT);
  const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
  const today = new Date().toISOString().slice(0, 10);

  console.log(`${currentVersion} -> ${newVersion}`);
  if (dryRun) {
    console.log('Would update:', all.map((f) => path.relative(REPO_ROOT, f)).join(', '));
    console.log('Would update: CHANGELOG.md');
    return;
  }

  for (const file of versioned) bumpManifestVersion(file, newVersion);
  for (const file of all) updateInternalDependencyRanges(file, newVersion);

  const changelog = readFileSync(changelogPath, 'utf8');
  writeFileSync(changelogPath, updateChangelog(changelog, { oldVersion: currentVersion, newVersion, date: today }));

  execFileSync('npm', ['install'], { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log('\nDone. Next steps:');
  console.log(`  git add -A && git commit -m "chore(release): v${newVersion}"`);
  console.log('  git push -u origin HEAD, then open a PR');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
```

- [ ] **Step 24: Run it to confirm it passes**

Run: `node --test scripts/bump-version.test.js`
Expected: PASS (11 tests)

- [ ] **Step 25: Commit**

```bash
git add scripts/bump-version.js scripts/bump-version.test.js
git commit -m "feat(release): add bump-version script"
```

---

## Task 2: `scripts/detect-bump-type.js`

**Files:**
- Create: `scripts/detect-bump-type.js`
- Test: `scripts/detect-bump-type.test.js`

- [ ] **Step 1: Write the failing tests for `classifyCommits`**

```js
// scripts/detect-bump-type.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyCommits,
  isReleasePending,
  getLastTag,
  getCommitMessagesSince,
} from './detect-bump-type.js';

test('classifyCommits: feat-only commits produce a minor bump', () => {
  const { type, breaking } = classifyCommits(['feat: add thing', 'chore: tidy']);
  assert.equal(type, 'minor');
  assert.equal(breaking, false);
});

test('classifyCommits: fix-only commits produce a patch bump', () => {
  const { type, breaking } = classifyCommits(['fix: correct thing', 'docs: typo']);
  assert.equal(type, 'patch');
  assert.equal(breaking, false);
});

test('classifyCommits: feat and fix together produce a minor bump', () => {
  const { type } = classifyCommits(['fix: correct thing', 'feat: add thing']);
  assert.equal(type, 'minor');
});

test('classifyCommits: chore/docs-only commits produce no bump', () => {
  const { type, breaking } = classifyCommits(['chore: tidy', 'docs: update readme']);
  assert.equal(type, 'none');
  assert.equal(breaking, false);
});

test('classifyCommits: a "!" after the type flags a breaking change without forcing major', () => {
  const { type, breaking } = classifyCommits(['feat!: drop old API']);
  assert.equal(type, 'minor');
  assert.equal(breaking, true);
});

test('classifyCommits: a BREAKING CHANGE footer flags a breaking change', () => {
  const message = 'fix: correct thing\n\nBREAKING CHANGE: removes the old flag';
  const { type, breaking } = classifyCommits([message]);
  assert.equal(type, 'patch');
  assert.equal(breaking, true);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: FAIL — `./detect-bump-type.js` does not exist yet.

- [ ] **Step 3: Create `scripts/detect-bump-type.js` with `classifyCommits`**

```js
// scripts/detect-bump-type.js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function classifyCommits(messages) {
  let sawFeat = false;
  let sawFix = false;
  let breaking = false;
  const headerRe = /^(\w+)(\([^)]*\))?(!)?:\s/;
  for (const message of messages) {
    const header = message.split('\n')[0];
    const match = headerRe.exec(header);
    if (!match) continue;
    const [, type, , bang] = match;
    if (type === 'feat') sawFeat = true;
    if (type === 'fix') sawFix = true;
    if (bang || /BREAKING CHANGE:/.test(message)) breaking = true;
  }
  const type = sawFeat ? 'minor' : sawFix ? 'patch' : 'none';
  return { type, breaking };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing tests for `isReleasePending`**

```js
// append to scripts/detect-bump-type.test.js
test('isReleasePending is false with no prior tag', () => {
  assert.equal(isReleasePending('1.0.0', null), false);
});

test('isReleasePending is false when the tag already matches the current version', () => {
  assert.equal(isReleasePending('1.0.0', 'v1.0.0'), false);
});

test('isReleasePending is true when the current version is ahead of the last tag', () => {
  assert.equal(isReleasePending('1.1.0', 'v1.0.0'), true);
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: FAIL — `isReleasePending` is not exported.

- [ ] **Step 7: Implement `isReleasePending`**

This guards against double-bumping: if `main`'s `package.json` is already ahead of
the last tag (a release-prep PR was merged but no one has pushed the tag yet),
there is nothing new to prepare.

```js
// add to scripts/detect-bump-type.js
export function isReleasePending(currentVersion, lastTag) {
  return Boolean(lastTag) && lastTag !== `v${currentVersion}`;
}
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: PASS (9 tests)

- [ ] **Step 9: Write the failing tests for `getLastTag` and `getCommitMessagesSince`**

These use real temporary git repos, the same pattern as `libs/git/test/git.test.js`.

```js
// append to scripts/detect-bump-type.test.js
function configureGit(dir) {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'detect-'));
  execFileSync('git', ['init', '-q', dir]);
  configureGit(dir);
  return dir;
}

function commit(dir, message) {
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', message]);
}

test('getLastTag returns null when the repo has no tags', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  assert.equal(await getLastTag(dir), null);
});

test('getLastTag returns the most recent v* tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  execFileSync('git', ['-C', dir, 'tag', 'v1.0.0']);
  commit(dir, 'feat: add thing');
  assert.equal(await getLastTag(dir), 'v1.0.0');
});

test('getCommitMessagesSince returns full history when there is no tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  commit(dir, 'feat: add thing');
  const messages = await getCommitMessagesSince(dir, null);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.startsWith('feat: add thing')));
});

test('getCommitMessagesSince only returns commits after the given tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  execFileSync('git', ['-C', dir, 'tag', 'v1.0.0']);
  commit(dir, 'feat: add thing');
  const messages = await getCommitMessagesSince(dir, 'v1.0.0');
  assert.equal(messages.length, 1);
  assert.ok(messages[0].startsWith('feat: add thing'));
});
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: FAIL — `getLastTag`/`getCommitMessagesSince` are not exported.

- [ ] **Step 11: Implement `getLastTag` and `getCommitMessagesSince`**

```js
// add to scripts/detect-bump-type.js
export async function defaultExec(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

export async function getLastTag(repoRoot, { exec = defaultExec } = {}) {
  try {
    const out = await exec(['describe', '--tags', '--abbrev=0', '--match', 'v*'], repoRoot);
    return out.trim();
  } catch {
    return null;
  }
}

export async function getCommitMessagesSince(repoRoot, lastTag, { exec = defaultExec } = {}) {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const out = await exec(['log', range, '--pretty=%B%x00'], repoRoot);
  return out
    .split('\0')
    .map((m) => m.trim())
    .filter(Boolean);
}
```

- [ ] **Step 12: Run it to confirm it passes**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: PASS (13 tests)

- [ ] **Step 13: Add the CLI wiring**

No new test for this step — it only orchestrates already-tested functions and
prints to stdout for the workflow to consume via `$GITHUB_OUTPUT`.

```js
// add to scripts/detect-bump-type.js
async function runCli() {
  const currentVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const lastTag = await getLastTag(REPO_ROOT);

  if (isReleasePending(currentVersion, lastTag)) {
    console.log('type=none');
    console.log('breaking=false');
    return;
  }

  const messages = await getCommitMessagesSince(REPO_ROOT, lastTag);
  const { type, breaking } = classifyCommits(messages);
  console.log(`type=${type}`);
  console.log(`breaking=${breaking}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
```

- [ ] **Step 14: Run the full suite once more to confirm nothing broke**

Run: `node --test scripts/detect-bump-type.test.js`
Expected: PASS (13 tests)

- [ ] **Step 15: Commit**

```bash
git add scripts/detect-bump-type.js scripts/detect-bump-type.test.js
git commit -m "feat(release): add detect-bump-type script"
```

---

## Task 3: `scripts/extract-changelog-section.js`

**Files:**
- Create: `scripts/extract-changelog-section.js`
- Test: `scripts/extract-changelog-section.test.js`

- [ ] **Step 1: Write the failing test for extracting a middle section**

```js
// scripts/extract-changelog-section.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChangelogSection } from './extract-changelog-section.js';

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- nothing yet',
  '',
  '## [0.2.0] - 2026-08-10',
  '',
  '### Added',
  '',
  '- Thing one.',
  '- Thing two.',
  '',
  '## [0.1.0]',
  '',
  'Initial release.',
  '',
  '[Unreleased]: https://github.com/linktogo/ai-sync/compare/v0.2.0...HEAD',
].join('\n');

test('extractChangelogSection returns the body between two headings', () => {
  const out = extractChangelogSection(SAMPLE, '0.2.0');
  assert.equal(out, '### Added\n\n- Thing one.\n- Thing two.\n');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: FAIL — `./extract-changelog-section.js` does not exist yet.

- [ ] **Step 3: Implement a first version using only `## ` as the stop marker**

```js
// scripts/extract-changelog-section.js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extractChangelogSection(changelogText, version) {
  const heading = `## [${version}]`;
  const start = changelogText.indexOf(heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  const afterHeadingLine = changelogText.indexOf('\n', start) + 1;
  const nextHeading = changelogText.indexOf('\n## ', afterHeadingLine);
  const end = nextHeading === -1 ? changelogText.length : nextHeading;
  return changelogText.slice(afterHeadingLine, end).trim() + '\n';
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Write the failing test for the last section in the file**

The real `CHANGELOG.md` ends with a block of `[label]: url` link references after
the last version's body — extracting the last section must stop before that
block, not swallow it.

```js
// append to scripts/extract-changelog-section.test.js
test('extractChangelogSection stops before the trailing link-reference block', () => {
  const out = extractChangelogSection(SAMPLE, '0.1.0');
  assert.equal(out, 'Initial release.\n');
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: FAIL — actual output includes the trailing `[Unreleased]: https://...` line.

- [ ] **Step 7: Extend the stop condition to also match link-reference lines**

```js
// replace extractChangelogSection in scripts/extract-changelog-section.js
export function extractChangelogSection(changelogText, version) {
  const heading = `## [${version}]`;
  const start = changelogText.indexOf(heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  const afterHeadingLine = changelogText.indexOf('\n', start) + 1;
  const stopPattern = /\n(## |\[[^\]]+\]: )/;
  const stopMatch = stopPattern.exec(changelogText.slice(afterHeadingLine));
  const end = stopMatch ? afterHeadingLine + stopMatch.index : changelogText.length;
  return changelogText.slice(afterHeadingLine, end).trim() + '\n';
}
```

- [ ] **Step 8: Run it to confirm both tests pass**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: PASS (2 tests)

- [ ] **Step 9: Write the failing test for a missing version**

```js
// append to scripts/extract-changelog-section.test.js
test('extractChangelogSection throws for a version with no section', () => {
  assert.throws(() => extractChangelogSection(SAMPLE, '9.9.9'), /no section for 9\.9\.9/);
});
```

- [ ] **Step 10: Run it to confirm it passes already**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: PASS (3 tests) — the guard clause from Step 3 already covers this.

- [ ] **Step 11: Add the CLI wiring**

```js
// add to scripts/extract-changelog-section.js
function runCli() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/extract-changelog-section.js <vX.Y.Z>');
    process.exitCode = 1;
    return;
  }
  const version = tag.replace(/^v/, '');
  const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  process.stdout.write(extractChangelogSection(changelog, version));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
```

- [ ] **Step 12: Run the full suite once more to confirm nothing broke**

Run: `node --test scripts/extract-changelog-section.test.js`
Expected: PASS (3 tests)

- [ ] **Step 13: Commit**

```bash
git add scripts/extract-changelog-section.js scripts/extract-changelog-section.test.js
git commit -m "feat(release): add extract-changelog-section script"
```

---

## Task 4: Wire the scripts into `npm test` and CI

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the `test:scripts` npm script**

In `package.json`, add to `"scripts"` (after `"test": "nx run-many -t test",`):

```json
    "test:scripts": "node --test scripts/*.test.js",
```

- [ ] **Step 2: Run it to confirm it passes**

Run: `npm run test:scripts`
Expected: PASS (27 tests: 11 from `bump-version.test.js`, 13 from
`detect-bump-type.test.js`, 3 from `extract-changelog-section.test.js`), 0 failures.

- [ ] **Step 3: Add the CI step**

In `.github/workflows/ci.yml`, add a step after `Test (100% coverage gate per project)`:

```yaml
      - name: Test (100% coverage gate per project)
        run: npx nx run-many -t test
      - name: Test release scripts
        run: npm run test:scripts
      - name: Build
        run: npx nx run-many -t build
```

- [ ] **Step 4: Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "chore(ci): run release script tests"
```

---

## Task 5: `.github/workflows/prepare-release.yml`

**Files:**
- Create: `.github/workflows/prepare-release.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Prepare release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: prepare-release
  cancel-in-progress: false

jobs:
  prepare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Detect bump type from commits since last tag
        id: detect
        run: node scripts/detect-bump-type.js >> "$GITHUB_OUTPUT"

      - name: Bump version
        if: steps.detect.outputs.type != 'none'
        run: node scripts/bump-version.js ${{ steps.detect.outputs.type }}

      - name: Read new version
        if: steps.detect.outputs.type != 'none'
        id: version
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

      - name: Open or update release PR
        if: steps.detect.outputs.type != 'none'
        uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/release-next
          commit-message: "chore(release): v${{ steps.version.outputs.version }}"
          title: "chore(release): v${{ steps.version.outputs.version }}"
          body: >-
            Automated ${{ steps.detect.outputs.type }} version bump to
            v${{ steps.version.outputs.version }}, computed from commits since
            the last release tag.${{ steps.detect.outputs.breaking == 'true' &&
            ' **Warning:** a breaking-change commit was detected — consider
            closing this PR and running `node scripts/bump-version.js major`
            instead.' || '' }}
          labels: release
```

`detect-bump-type.js` prints `type=none` whenever there's nothing to bump
**or** a release is already prepared and awaiting a tag (see `isReleasePending`
in Task 2), so this workflow is safe to let run on every push to `main`,
including the push that lands the release PR itself — no separate loop guard
needed.

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/prepare-release.yml'))"`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/prepare-release.yml
git commit -m "feat(ci): auto-prepare patch/minor release PRs"
```

---

## Task 6: `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Create release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Verify tag matches package.json version
        run: |
          tag="${GITHUB_REF_NAME#v}"
          pkg="$(node -p "require('./package.json').version")"
          if [ "$tag" != "$pkg" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $pkg" >&2
            exit 1
          fi

      - name: Extract changelog section for this version
        run: node scripts/extract-changelog-section.js "${{ github.ref_name }}" > /tmp/notes.md

      - name: Create GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "${{ github.ref_name }}" --title "${{ github.ref_name }}" --notes-file /tmp/notes.md
```

No `lk-publish` check is needed inside this workflow: only `lk-publish` can
push the `v*` tag that triggers it, once the tag ruleset from Task 8 is
configured.

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/release.yml'))"`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): auto-create GitHub releases with changelog notes on tag push"
```

---

## Task 7: Gate `publish.yml` behind the `npm-publish` environment

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Add the environment**

In `.github/workflows/publish.yml`, change:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # required for npm provenance
```

to:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish
    permissions:
      contents: read
      id-token: write # required for npm provenance
```

Nothing else in this file changes — the version-match guard, `npm test`, and
the two `npm publish` steps stay exactly as they are today.

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/publish.yml'))"`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "feat(ci): require lk-publish approval on the npm-publish environment"
```

This has no effect until the `npm-publish` environment exists with `lk-publish`
as a required reviewer — set up in Task 8.

---

## Task 8: `scripts/setup-release-protections.sh`

**Files:**
- Create: `scripts/setup-release-protections.sh`

This is an operator-run, one-time helper — it is never invoked by CI. It
requires `gh` to be authenticated with an account that has admin rights on
`linktogo/ai-sync`, and the `lk-publish` GitHub team to already exist. There is
no automated test for it (it drives live GitHub org/repo settings); Step 3
below is manual verification instead.

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# One-time setup for the two lk-publish release gates. Run by hand, once,
# after the lk-publish GitHub team exists. Requires repo-admin `gh` auth.
set -euo pipefail

OWNER="linktogo"
REPO="ai-sync"
TEAM="lk-publish"
ENVIRONMENT="npm-publish"

echo "Looking up team $OWNER/$TEAM..."
TEAM_ID="$(gh api "orgs/$OWNER/teams/$TEAM" --jq .id)" || {
  echo "Team '$TEAM' was not found in org '$OWNER' (or is not visible to your token)." >&2
  echo "Create it first, then re-run this script." >&2
  exit 1
}
echo "Found team id $TEAM_ID"

echo "Configuring environment '$ENVIRONMENT' with $TEAM as required reviewer..."
gh api --method PUT "repos/$OWNER/$REPO/environments/$ENVIRONMENT" \
  -f "reviewers[0][type]=Team" \
  -F "reviewers[0][id]=$TEAM_ID" >/dev/null
echo "Environment configured — only $TEAM members can approve a run using it."

echo "Configuring tag ruleset restricting v* tag creation to $TEAM..."
gh api --method POST "repos/$OWNER/$REPO/rulesets" \
  -f "name=release-tags" \
  -f "target=tag" \
  -f "enforcement=active" \
  -f "conditions[ref_name][include][]=refs/tags/v*" \
  -f "rules[0][type]=creation" \
  -f "bypass_actors[0][actor_type]=Team" \
  -F "bypass_actors[0][actor_id]=$TEAM_ID" \
  -f "bypass_actors[0][bypass_mode]=always" >/dev/null
echo "Ruleset configured — only $TEAM can create v* tags."

echo "Done. Verify under Settings > Environments and Settings > Rules on the repo."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/setup-release-protections.sh
```

- [ ] **Step 3: Manual verification (run by the operator, not as part of this task)**

After the `lk-publish` team exists and `NPM_TOKEN` is set:

```bash
./scripts/setup-release-protections.sh
```

Then confirm in the GitHub UI: Settings → Environments → `npm-publish` lists
`lk-publish` as a required reviewer, and Settings → Rules lists a ruleset
covering `refs/tags/v*` with `lk-publish` as the only bypass actor. Push a test
`v*` tag as a non-`lk-publish` user (or check with someone who is one) to
confirm the push is rejected.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-release-protections.sh
git commit -m "chore(release): add one-time lk-publish gate setup script"
```

---

## Task 9: Rewrite the `CONTRIBUTING.md` "Releasing" section

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Replace the section**

Replace the entire existing `## Releasing` section (from `## Releasing` through
the `npm pack --dry-run --workspace @linktogo/ai-renderers` line, i.e. everything
up to but not including `## Reporting bugs and requesting features`) with:

````markdown
## Releasing

Six packages ship from this repository and are versioned **in lockstep**: the
CLI package `@linktogo/ai-sync` (the repo root) and the five `@linktogo/ai-*`
libraries under `libs/`. The libraries depend on each other by caret range
(`^0.1.0`), so a version that moves in one place must move everywhere.

### Patch and minor releases (automatic)

Every push to `main` runs `.github/workflows/prepare-release.yml`, which looks
at commits since the last release tag and opens or updates a
`chore(release): vX.Y.Z` pull request with the version already bumped
(`node scripts/bump-version.js patch|minor`, run for you) and the
`Unreleased` section of `CHANGELOG.md` moved under the new version heading.
Any `feat:` commit produces a minor bump; any `fix:` commit (with no `feat:`)
produces a patch bump; anything else is a no-op. Review and merge that PR like
any other change.

If a commit contains a `BREAKING CHANGE:` footer or a `!` after its type
(`feat!:`), the workflow still opens a patch/minor PR but flags it as
recommending a manual major bump instead — it never bumps major on its own.

### Major releases (manual)

Run the bump script yourself:

```bash
node scripts/bump-version.js major
git add -A && git commit -m "chore(release): vX.Y.Z"
git push -u origin HEAD
```

Then open a PR the same way.

### Publishing (gated to `lk-publish`)

Once the version-bump PR is merged to `main`, an `lk-publish` team member
pushes the release tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Only `lk-publish` can create tags matching `v*` (enforced by a repository tag
ruleset). Pushing the tag triggers `.github/workflows/release.yml`, which
verifies the tag matches `package.json`, extracts the matching section of
`CHANGELOG.md`, and creates a GitHub Release with it as the notes — no
hand-written release notes needed.

That Release's `published` event triggers `.github/workflows/publish.yml`,
which requires a second, independent approval from an `lk-publish` reviewer on
the `npm-publish` environment before it runs `npm publish --workspaces`
(libraries) and then `npm publish` (the CLI package, which depends on them).

To rehearse a release against a local registry:

```bash
npm run publish:verdaccio   # publishes the five libraries to http://localhost:4873
```

Check what a tarball would actually contain before releasing:

```bash
npm pack --dry-run                                # the CLI package
npm pack --dry-run --workspace @linktogo/ai-renderers # one library
```
````

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: rewrite the Releasing section for the new automated flow"
```

---

## Out of scope reminders (see spec for full rationale)

- No automatic major bumps under any circumstance.
- No changelog prose generated from commit messages — only the bump *type* is
  derived from commits; changelog content stays hand-maintained under
  `Unreleased`.
- No `release-please`/`changesets` adoption.
- No pre-release/tag-channel support.
- Creating the `lk-publish` team and setting `NPM_TOKEN` are operator actions
  outside this plan.
