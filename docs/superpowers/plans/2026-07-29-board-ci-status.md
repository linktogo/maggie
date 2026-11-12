# Board CI Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each managed repo's latest CI outcome, per contributor, on the workspace board.

**Architecture:** Managed repos push their CI result through a shared composite action that commits `updates/<login>/<repo>.json` into the orphan `ci-status` branch of this repository — one file per (user, repo), overwritten on each run. The board server is a pure reader: it fetches that branch on a timer, rebuilds a local `ci.json` cache, and serves `/api/ci`. The Vue board renders one badge per contributor per card.

**Tech Stack:** Node 22 (ESM), Nx 23 workspace, `node --test` with a 100% line/function/branch gate for libs, Vitest + `@vue/test-utils` for the Vue app, Tailwind, GitHub Actions composite action.

**Spec:** `docs/superpowers/specs/2026-07-29-board-ci-status-design.md`

---

## File structure

**Created**

| File | Responsibility |
|---|---|
| `libs/ci-status/package.json` | npm workspace manifest for `@ai-sync/ci-status` |
| `libs/ci-status/project.json` | Nx project + `node --test` 100% coverage target |
| `libs/ci-status/src/ci-status.js` | All pure logic: state mapping, ranking, payload building, validation, state folding |
| `libs/ci-status/test/ci-status.test.js` | Its tests |
| `.github/actions/ci-status-report/action.yml` | Composite action surface (inputs, steps) |
| `.github/actions/ci-status-report/report.js` | Deposit script: build payload, write file, push with retry |
| `apps/board/ciReader.js` | Read-only consumer: fetch branch, parse files, write `ci.json`, serve state |
| `apps/board/ciReader.test.js` | Its tests (`node --test`, injected `exec`/`fs`) |
| `apps/board/src/ciBadge.js` | Presentation helpers: initials, badge ordering/overflow, pill classes, filter predicate |
| `apps/board/src/ciBadge.test.js` | Its tests (Vitest) |
| `apps/board/src/useCi.js` | Polls `/api/ci` |
| `apps/board/src/useCi.test.js` | Its tests (Vitest) |

**Modified**

| File | Change |
|---|---|
| `libs/git/src/git.js` | `push(branch, { force = false })` — force becomes opt-in |
| `libs/git/test/git.test.js` | Pin both force modes |
| `libs/skill-sync/src/pipeline.js:88` | Pass `{ force: true }` explicitly |
| `apps/board/package.json` | Depend on `@ai-sync/ci-status` |
| `apps/board/server.js` | Build the reader, add `/api/ci`, add four CLI flags |
| `apps/board/server.test.js` | Cover `/api/ci` |
| `apps/board/src/Card.vue` | Contributor badges |
| `apps/board/src/Card.test.js` | Badge assertions |
| `apps/board/src/Column.vue` | Relay `ci` prop to `Card` |
| `apps/board/src/RepoDetail.vue` | Per-contributor CI block |
| `apps/board/src/RepoDetail.test.js` | Block assertions |
| `apps/board/src/FilterBar.vue` | CI filter select |
| `apps/board/src/FilterBar.test.js` | Filter emit assertion |
| `apps/board/src/App.vue` | Wire `useCi`, apply the CI filter, show the desync banner |
| `apps/board/src/App.test.js` | Wiring assertions |
| `README.md` | Setup: orphan branch, per-repo workflow, server flags |

---

## Task 0: Baseline

- [ ] **Step 1: Install and confirm green**

```bash
npm ci
npx nx run-many -t test
```

Expected: `Successfully ran target test for 8 projects`, 29 Vitest tests passing. Do not start until this is green — every later task compares against it.

---

## Task 1: Make force-push opt-in in `libs/git`

Force-pushing `ci-status` would drop files other contributors pushed between our fetch and our push. `push()` is force today and has exactly one production caller.

**Files:**
- Modify: `libs/git/src/git.js:23-25`
- Modify: `libs/skill-sync/src/pipeline.js:88`
- Test: `libs/git/test/git.test.js`

- [ ] **Step 1: Write the failing test**

Append to `libs/git/test/git.test.js`:

```js
test('push omits -f by default and includes it when force is set', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', {
    exec: async (file, args) => { calls.push(args); return ''; },
  });
  await repo.push('ci-status');
  await repo.push('ai-sync/update-skills', { force: true });
  assert.deepEqual(calls[0], ['push', '-u', 'origin', 'ci-status']);
  assert.deepEqual(calls[1], ['push', '-f', '-u', 'origin', 'ai-sync/update-skills']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run git:test
```

Expected: FAIL — `calls[0]` is `['push','-f','-u','origin','ci-status']`.

- [ ] **Step 3: Implement**

In `libs/git/src/git.js`, replace the `push` method:

```js
    async push(branch, { force = false } = {}) {
      const args = ['push'];
      if (force) args.push('-f');
      args.push('-u', 'origin', branch);
      await git(...args);
    },
```

- [ ] **Step 4: Keep the existing caller's behaviour**

In `libs/skill-sync/src/pipeline.js:88`, change:

```js
  await gitRepo.push(BRANCH);
```

to:

```js
  await gitRepo.push(BRANCH, { force: true });
```

- [ ] **Step 5: Run both suites**

```bash
npx nx run git:test && npx nx run skill-sync:test
```

Expected: PASS, both at 100% coverage.

- [ ] **Step 6: Commit**

```bash
git add libs/git/src/git.js libs/git/test/git.test.js libs/skill-sync/src/pipeline.js
git commit -m "feat(git): make force-push opt-in

Force-pushing a shared drop branch would discard commits pushed between
fetch and push. The sync pipeline, the only caller, opts in explicitly."
```

---

## Task 2: Scaffold `libs/ci-status` with `normalizeState` and `rankState`

**Files:**
- Create: `libs/ci-status/package.json`
- Create: `libs/ci-status/project.json`
- Create: `libs/ci-status/src/ci-status.js`
- Test: `libs/ci-status/test/ci-status.test.js`

- [ ] **Step 1: Create the workspace manifest**

`libs/ci-status/package.json`:

```json
{
  "name": "@ai-sync/ci-status",
  "version": "0.0.1",
  "type": "module",
  "main": "./src/ci-status.js",
  "publishConfig": {
    "registry": "http://localhost:4873"
  }
}
```

- [ ] **Step 2: Create the Nx project**

`libs/ci-status/project.json` — the coverage command mirrors `libs/config/project.json` exactly:

```json
{
  "name": "ci-status",
  "sourceRoot": "libs/ci-status/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node --test --experimental-test-coverage --test-coverage-include=\"libs/ci-status/src/**/*.js\" --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 \"libs/ci-status/test/**/*.test.js\""
      }
    }
  }
}
```

- [ ] **Step 3: Link the new workspace**

```bash
npm install
```

Expected: `node_modules/@ai-sync/ci-status` becomes a symlink to `libs/ci-status`.

- [ ] **Step 4: Write the failing test**

`libs/ci-status/test/ci-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, rankState } from '../src/ci-status.js';

test('normalizeState maps every GitHub status/conclusion pair', () => {
  const cases = [
    [['queued', null], 'running'],
    [['in_progress', null], 'running'],
    [['waiting', null], 'running'],
    [['completed', 'success'], 'success'],
    [['completed', 'failure'], 'failure'],
    [['completed', 'timed_out'], 'failure'],
    [['completed', 'startup_failure'], 'failure'],
    [['completed', 'action_required'], 'failure'],
    [['completed', 'cancelled'], 'neutral'],
    [['completed', 'skipped'], 'neutral'],
    [['completed', 'neutral'], 'neutral'],
    [['completed', 'stale'], 'neutral'],
    [['completed', 'something_new'], 'neutral'],
    [['completed', null], 'neutral'],
  ];
  for (const [[status, conclusion], expected] of cases) {
    assert.equal(normalizeState(status, conclusion), expected, `${status}/${conclusion}`);
  }
});

test('rankState orders worst first and treats unknown states as none', () => {
  assert.ok(rankState('failure') < rankState('running'));
  assert.ok(rankState('running') < rankState('neutral'));
  assert.ok(rankState('neutral') < rankState('success'));
  assert.ok(rankState('success') < rankState('none'));
  assert.equal(rankState('bogus'), rankState('none'));
});
```

- [ ] **Step 5: Run it and watch it fail**

```bash
npx nx run ci-status:test
```

Expected: FAIL — `Cannot find module '../src/ci-status.js'`.

- [ ] **Step 6: Implement**

`libs/ci-status/src/ci-status.js`:

```js
// Conclusions that mean "someone has to look at this". Everything else that is
// completed and not a success is informational (cancelled, skipped, stale…).
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

// One total order, used both to sort badges worst-first and to aggregate a
// repo's contributors into a single verdict for the filter. Keeping a single
// definition is what stops the card ordering and the filter from disagreeing.
const RANK = { failure: 0, running: 1, neutral: 2, success: 3, none: 4 };

export function normalizeState(status, conclusion) {
  if (status !== 'completed') return 'running';
  if (conclusion === 'success') return 'success';
  if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failure';
  return 'neutral';
}

export function rankState(state) {
  return RANK[state] ?? RANK.none;
}
```

- [ ] **Step 7: Run it and watch it pass**

```bash
npx nx run ci-status:test
```

Expected: PASS, 100% lines/functions/branches.

- [ ] **Step 8: Commit**

```bash
git add libs/ci-status package-lock.json package.json
git commit -m "feat(ci-status): add lib with CI state mapping and ranking"
```

---

## Task 3: `parseUpdate`

Validates one status file, including that it sits in the folder its payload claims.

**Files:**
- Modify: `libs/ci-status/src/ci-status.js`
- Test: `libs/ci-status/test/ci-status.test.js`

- [ ] **Step 1: Write the failing test**

Append to `libs/ci-status/test/ci-status.test.js` (and add `parseUpdate` to the import at the top):

```js
const VALID = {
  repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
  conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
  url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
  startedAt: '2026-07-29T18:40:00.000Z', sentAt: '2026-07-29T18:41:12.000Z',
};
const AT = { login: 'fabien', repo: 'lk-myasso' };

test('parseUpdate accepts a well-formed payload', () => {
  const result = parseUpdate(JSON.stringify(VALID), AT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.update, VALID);
});

test('parseUpdate accepts a null conclusion for a run still going', () => {
  const raw = JSON.stringify({ ...VALID, status: 'in_progress', conclusion: null });
  assert.equal(parseUpdate(raw, AT).ok, true);
});

test('parseUpdate rejects malformed input without throwing', () => {
  const cases = [
    ['not json at all', /invalid JSON/],
    ['[]', /not an object/],
    ['null', /not an object/],
    [JSON.stringify({ ...VALID, repo: undefined }), /"repo"/],
    [JSON.stringify({ ...VALID, actor: '' }), /"actor"/],
    [JSON.stringify({ ...VALID, status: 7 }), /"status"/],
    [JSON.stringify({ ...VALID, runId: 'forty-two' }), /"runId"/],
  ];
  for (const [raw, pattern] of cases) {
    const result = parseUpdate(raw, AT);
    assert.equal(result.ok, false, raw);
    assert.match(result.reason, pattern);
  }
});

test('parseUpdate rejects a file sitting in the wrong folder or under the wrong name', () => {
  const wrongUser = parseUpdate(JSON.stringify(VALID), { login: 'alice', repo: 'lk-myasso' });
  assert.equal(wrongUser.ok, false);
  assert.match(wrongUser.reason, /actor "fabien" does not match folder "alice"/);

  const wrongRepo = parseUpdate(JSON.stringify(VALID), { login: 'fabien', repo: 'lk-mind' });
  assert.equal(wrongRepo.ok, false);
  assert.match(wrongRepo.reason, /repo "lk-myasso" does not match file "lk-mind"/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run ci-status:test
```

Expected: FAIL — `parseUpdate is not a function`.

- [ ] **Step 3: Implement**

Append to `libs/ci-status/src/ci-status.js`:

```js
const REQUIRED_STRINGS = ['repo', 'actor', 'status'];

// Never throws: a bad file on the branch must degrade to a skipped entry, not
// take the whole read down. `at` is where the file was found, so a payload that
// disagrees with its own path is rejected rather than silently reattributed.
export function parseUpdate(raw, at) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      return { ok: false, reason: `missing or invalid "${field}"` };
    }
  }
  if (!Number.isInteger(parsed.runId)) {
    return { ok: false, reason: 'missing or invalid "runId"' };
  }
  if (parsed.actor !== at.login) {
    return { ok: false, reason: `actor "${parsed.actor}" does not match folder "${at.login}"` };
  }
  if (parsed.repo !== at.repo) {
    return { ok: false, reason: `repo "${parsed.repo}" does not match file "${at.repo}"` };
  }
  return { ok: true, update: parsed };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run ci-status:test
```

Expected: PASS, still 100%.

- [ ] **Step 5: Commit**

```bash
git add libs/ci-status
git commit -m "feat(ci-status): validate status files against their own path"
```

---

## Task 4: `buildUpdate` for both trigger contexts

**Files:**
- Modify: `libs/ci-status/src/ci-status.js`
- Test: `libs/ci-status/test/ci-status.test.js`

- [ ] **Step 1: Write the failing test**

Append (and add `buildUpdate` to the import):

```js
const NOW = '2026-07-29T18:41:12.000Z';

test('buildUpdate reads the workflow_run payload when triggered by workflow_run', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'linktogo/lk-myasso' };
  const event = {
    workflow_run: {
      id: 42, name: 'CI', status: 'completed', conclusion: 'failure',
      head_branch: 'feat/x', event: 'push', actor: { login: 'fabien' },
      html_url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
      run_started_at: '2026-07-29T18:40:00.000Z',
    },
  };
  assert.deepEqual(buildUpdate(env, event, NOW), {
    repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
    conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
    startedAt: '2026-07-29T18:40:00.000Z', sentAt: NOW,
  });
});

test('buildUpdate reads the job context when used as an in-job step', () => {
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'linktogo/lk-mind',
    GITHUB_ACTOR: 'alice', GITHUB_RUN_ID: '77', GITHUB_WORKFLOW: 'Build',
    GITHUB_REF_NAME: 'main', GITHUB_SERVER_URL: 'https://github.com',
    JOB_STATUS: 'success',
  };
  assert.deepEqual(buildUpdate(env, {}, NOW), {
    repo: 'lk-mind', actor: 'alice', runId: 77, status: 'completed',
    conclusion: 'success', workflow: 'Build', branch: 'main', event: 'push',
    url: 'https://github.com/linktogo/lk-mind/actions/runs/77',
    startedAt: NOW, sentAt: NOW,
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run ci-status:test
```

Expected: FAIL — `buildUpdate is not a function`.

- [ ] **Step 3: Implement**

Append to `libs/ci-status/src/ci-status.js`:

```js
function repoName(env) {
  return env.GITHUB_REPOSITORY.split('/')[1];
}

// The workflow_run event carries the conclusion of the *whole* workflow, which
// is the only place `cancelled` is observable.
function fromWorkflowRun(env, run, now) {
  return {
    repo: repoName(env),
    actor: run.actor.login,
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    workflow: run.name,
    branch: run.head_branch,
    event: run.event,
    url: run.html_url,
    startedAt: run.run_started_at,
    sentAt: now,
  };
}

// As a final `if: always()` step we only ever see our own job, and by
// definition it is finished, so status is pinned to completed and the
// conclusion comes from `job.status`.
function fromJob(env, now) {
  return {
    repo: repoName(env),
    actor: env.GITHUB_ACTOR,
    runId: Number(env.GITHUB_RUN_ID),
    status: 'completed',
    conclusion: env.JOB_STATUS,
    workflow: env.GITHUB_WORKFLOW,
    branch: env.GITHUB_REF_NAME,
    event: env.GITHUB_EVENT_NAME,
    url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    startedAt: now,
    sentAt: now,
  };
}

export function buildUpdate(env, event, now) {
  return env.GITHUB_EVENT_NAME === 'workflow_run'
    ? fromWorkflowRun(env, event.workflow_run, now)
    : fromJob(env, now);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run ci-status:test
```

Expected: PASS, still 100%.

- [ ] **Step 5: Commit**

```bash
git add libs/ci-status
git commit -m "feat(ci-status): build the status payload from both trigger contexts"
```

---

## Task 5: `buildState`

**Files:**
- Modify: `libs/ci-status/src/ci-status.js`
- Test: `libs/ci-status/test/ci-status.test.js`

- [ ] **Step 1: Write the failing test**

Append (and add `buildState` to the import):

```js
test('buildState groups by repo then by contributor and stamps receivedAt', () => {
  const entries = [
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 42 } },
    { login: 'alice', repo: 'lk-myasso', update: { ...VALID, actor: 'alice', runId: 41, conclusion: 'success' } },
    { login: 'fabien', repo: 'lk-mind', update: { ...VALID, repo: 'lk-mind', runId: 9 } },
  ];
  const state = buildState(entries, NOW);
  assert.deepEqual(Object.keys(state.repos).sort(), ['lk-mind', 'lk-myasso']);
  assert.deepEqual(Object.keys(state.repos['lk-myasso'].users).sort(), ['alice', 'fabien']);
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.equal(state.repos['lk-myasso'].users.fabien.receivedAt, NOW);
});

test('buildState keeps the highest runId when a pair appears twice', () => {
  const entries = [
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 42 } },
    { login: 'fabien', repo: 'lk-myasso', update: { ...VALID, runId: 7 } },
  ];
  assert.equal(buildState(entries, NOW).repos['lk-myasso'].users.fabien.runId, 42);
});

test('buildState does not mutate the updates it is given', () => {
  const update = { ...VALID };
  buildState([{ login: 'fabien', repo: 'lk-myasso', update }], NOW);
  assert.equal(update.receivedAt, undefined);
});

test('buildState returns an empty map for no entries', () => {
  assert.deepEqual(buildState([], NOW), { repos: {} });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run ci-status:test
```

Expected: FAIL — `buildState is not a function`.

- [ ] **Step 3: Implement**

Append to `libs/ci-status/src/ci-status.js`:

```js
// The branch holds one file per (user, repo), so a duplicate pair can only come
// from a hand-edited branch. Preferring the higher runId makes the fold
// deterministic whatever order readdir returns.
export function buildState(entries, now) {
  const repos = {};
  for (const { login, repo, update } of entries) {
    const bucket = (repos[repo] ??= { users: {} });
    const existing = bucket.users[login];
    if (existing && existing.runId >= update.runId) continue;
    bucket.users[login] = { ...update, receivedAt: now };
  }
  return { repos };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run ci-status:test
```

Expected: PASS, 100%. The lib is now complete.

- [ ] **Step 5: Commit**

```bash
git add libs/ci-status
git commit -m "feat(ci-status): fold status files into per-repo, per-user state"
```

---

## Task 6: The composite action

**Files:**
- Create: `.github/actions/ci-status-report/action.yml`
- Create: `.github/actions/ci-status-report/report.js`

There is no test target here — this is the plan's one accepted blind spot, which is why every decision it makes is delegated to the covered lib.

- [ ] **Step 1: Write the deposit script**

`.github/actions/ci-status-report/report.js`:

```js
#!/usr/bin/env node
// Deposits this run's CI status into the ai-sync `ci-status` branch as
// updates/<login>/<repo>.json. Imported by relative path so the runner needs no
// npm install: both libs are dependency-free.
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildUpdate, parseUpdate } from '../../../libs/ci-status/src/ci-status.js';
import { clone } from '../../../libs/git/src/git.js';

const ATTEMPTS = 5;

async function readEvent(file) {
  if (!file) return {};
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

// Reset-and-rewrite rather than rebase: each attempt lays our single file on top
// of whatever the remote currently holds, so there is never a conflict to
// resolve. The runId comparison stops two runs landing out of order from
// flip-flopping the file.
async function deposit(repo, update, branch) {
  const rel = path.join('updates', update.actor, `${update.repo}.json`);
  const file = path.join(repo.dir, rel);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const existing = await readFile(file, 'utf8').catch(() => null);
    if (existing) {
      const parsed = parseUpdate(existing, { login: update.actor, repo: update.repo });
      if (parsed.ok && parsed.update.runId > update.runId) {
        console.log(`ai-sync: run ${parsed.update.runId} already reported, skipping ${update.runId}`);
        return;
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(update, null, 2)}\n`);
    if (!(await repo.hasChanges())) {
      console.log('ai-sync: status unchanged, nothing to push');
      return;
    }
    await repo.commitAll(`chore(ci-status): ${update.actor}/${update.repo} ${update.conclusion ?? update.status}`);
    try {
      await repo.push(branch);
      console.log(`ai-sync: reported ${rel}`);
      return;
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
      console.log(`ai-sync: push rejected (attempt ${attempt}/${ATTEMPTS}), retrying`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
      await repo.fetchReset(branch);
    }
  }
}

const { INPUT_TOKEN, INPUT_STATUS_REPO, INPUT_BRANCH, GITHUB_EVENT_PATH } = process.env;
const url = `https://x-access-token:${INPUT_TOKEN}@github.com/${INPUT_STATUS_REPO}.git`;
const dir = path.join(await mkdtemp(path.join(tmpdir(), 'ai-sync-status-')), 'repo');

try {
  const update = buildUpdate(process.env, await readEvent(GITHUB_EVENT_PATH), new Date().toISOString());
  const repo = await clone(url, dir, { depth: 1, branch: INPUT_BRANCH });
  await repo.configureIdentity('ai-sync[bot]', 'ai-sync@users.noreply.github.com');
  await deposit(repo, update, INPUT_BRANCH);
} catch (err) {
  // Never let the token reach the log, even through a git error message. Guard
  // against an empty token: splitting on '' would interleave '***' between
  // every character of the message instead of leaving it untouched.
  const message = INPUT_TOKEN ? String(err.message).split(INPUT_TOKEN).join('***') : String(err.message);
  console.error(`ai-sync: ${message}`);
  // exitCode (not exit()) so this `finally` still runs and the temp clone
  // — whose .git/config holds the token in the remote URL — gets removed.
  process.exitCode = 1;
} finally {
  await rm(path.dirname(dir), { recursive: true, force: true });
}
```

Notes on the fixes above versus the first draft: `buildUpdate`/`readEvent` moved inside the `try` so a malformed `workflow_run` event payload fails through the redacted `catch` instead of throwing an unhandled `TypeError`; `dir` is computed before the `try` so `finally` can always find it; `deposit` takes `repo` alone and reads `repo.dir` instead of a redundant `dir` parameter; and the process exits via `process.exitCode = 1` rather than `process.exit(1)`, because `exit()` would skip the `finally` cleanup entirely and leave the temp clone's `.git/config` — which embeds the token in the remote URL — on disk.

- [ ] **Step 2: Add the three `libs/git` helpers the script needs**

`clone` has no `branch` option, and `createRepo` has neither `fetchReset` nor `configureIdentity`. Write the failing test first — append to `libs/git/test/git.test.js`:

```js
test('clone passes --branch --single-branch when a branch is given', async () => {
  const calls = [];
  const exec = async (file, args) => { calls.push(args); return ''; };
  await clone('url', '/dest', { exec, depth: 1, branch: 'ci-status' });
  assert.deepEqual(calls[0], ['clone', '--depth', '1', '--branch', 'ci-status', '--single-branch', 'url', '/dest']);
});

test('fetchReset re-points the checkout at the remote branch', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', { exec: async (file, args) => { calls.push(args); return ''; } });
  await repo.fetchReset('ci-status');
  assert.deepEqual(calls, [
    ['fetch', 'origin', 'ci-status'],
    ['reset', '--hard', 'origin/ci-status'],
  ]);
});

test('configureIdentity sets the local committer', async () => {
  const calls = [];
  const repo = createRepo('/somewhere', { exec: async (file, args) => { calls.push(args); return ''; } });
  await repo.configureIdentity('ai-sync[bot]', 'bot@example.com');
  assert.deepEqual(calls, [
    ['config', 'user.name', 'ai-sync[bot]'],
    ['config', 'user.email', 'bot@example.com'],
  ]);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx nx run git:test
```

Expected: FAIL — `repo.fetchReset is not a function`.

- [ ] **Step 4: Implement them**

In `libs/git/src/git.js`, add two methods inside the `createRepo` return object:

```js
    async fetchReset(branch) {
      await git('fetch', 'origin', branch);
      await git('reset', '--hard', `origin/${branch}`);
    },
    async configureIdentity(name, email) {
      await git('config', 'user.name', name);
      await git('config', 'user.email', email);
    },
```

and extend `clone`:

```js
export async function clone(url, dir, { exec = defaultExec, depth, branch } = {}) {
  const args = ['clone'];
  if (depth) args.push('--depth', String(depth));
  if (branch) args.push('--branch', branch, '--single-branch');
  args.push(url, dir);
  await exec('git', args, {});
  return createRepo(dir, { exec });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
npx nx run git:test
```

Expected: PASS, 100%.

- [ ] **Step 6: Write the action surface**

`.github/actions/ci-status-report/action.yml`:

```yaml
name: ai-sync CI status report
description: Report this repository's CI outcome to the ai-sync board.
inputs:
  token:
    description: Token with write access to the status repository's ci-status branch.
    required: true
  status-repo:
    description: owner/name of the repository holding the ci-status branch.
    required: false
    default: linktogo/ai-sync
  branch:
    description: Branch holding the updates/ folder.
    required: false
    default: ci-status
runs:
  using: composite
  steps:
    - name: Report CI status
      shell: bash
      run: node "$GITHUB_ACTION_PATH/report.js"
      env:
        INPUT_TOKEN: ${{ inputs.token }}
        INPUT_STATUS_REPO: ${{ inputs.status-repo }}
        INPUT_BRANCH: ${{ inputs.branch }}
        JOB_STATUS: ${{ job.status }}
```

- [ ] **Step 7: Lint and commit**

```bash
npx nx run-many -t lint
git add .github/actions/ci-status-report libs/git
git commit -m "feat(actions): add composite action reporting CI status to the board

Deposits updates/<login>/<repo>.json on the ci-status branch, retrying with
reset-and-rewrite so concurrent deposits never conflict."
```

---

## Task 7: The board's read-only consumer

**Files:**
- Create: `apps/board/ciReader.js`
- Create: `apps/board/ciReader.test.js`
- Modify: `apps/board/package.json`

- [ ] **Step 1: Declare the dependency and the test target**

In `apps/board/package.json`, add to `dependencies`:

```json
    "@ai-sync/ci-status": "*",
```

and add a target inside the `nx.targets` block, alongside `test-server`:

```json
      "test-reader": {
        "executor": "nx:run-commands",
        "options": { "command": "node --test apps/board/ciReader.test.js" }
      },
```

then extend the existing `test` target's `dependsOn`:

```json
      "test": {
        "dependsOn": ["test-server", "test-reader"]
      }
```

Run `npm install` to link the new dependency.

- [ ] **Step 2: Write the failing test**

`apps/board/ciReader.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCiReader } from './ciReader.js';

const NOW = '2026-07-29T18:41:12.000Z';

function update(over = {}) {
  return {
    repo: 'lk-myasso', actor: 'fabien', runId: 42, status: 'completed',
    conclusion: 'failure', workflow: 'CI', branch: 'feat/x', event: 'push',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
    startedAt: NOW, sentAt: NOW, ...over,
  };
}

// Builds a fake checkout that a stubbed `exec` pretends to have cloned.
async function fixture(files = { 'fabien/lk-myasso.json': update() }) {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-reader-'));
  const cacheDir = path.join(root, 'ci-status');
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(cacheDir, 'updates', rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  await mkdir(path.join(cacheDir, '.git'), { recursive: true });
  return { root, cacheDir, stateFile: path.join(root, 'ci.json') };
}

function reader(over, calls = []) {
  return createCiReader({
    statusRepo: 'https://github.com/linktogo/ai-sync.git',
    exec: async (file, args, opts) => { calls.push({ args, opts }); return ''; },
    now: () => NOW,
    logger: { log() {}, warn() {} },
    ...over,
  });
}

test('tick fetches, resets and writes the state cache', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.deepEqual(calls[0].args, ['fetch', '--depth', '1', 'origin', 'ci-status']);
  assert.deepEqual(calls[1].args, ['reset', '--hard', 'origin/ci-status']);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.equal(state.lastSyncError, null);
  await rm(root, { recursive: true, force: true });
});

test('tick clones when there is no checkout yet', async () => {
  const { root, stateFile } = await fixture();
  const cacheDir = path.join(root, 'absent');
  const calls = [];
  await reader({ cacheDir, stateFile }, calls).tick();
  assert.equal(calls[0].args[0], 'clone');
  assert.ok(calls[0].args.includes('ci-status'));
  await rm(root, { recursive: true, force: true });
});

test('tick skips malformed files and keeps the good ones', async () => {
  const warnings = [];
  const { root, cacheDir, stateFile } = await fixture({
    'fabien/lk-myasso.json': update(),
    'fabien/broken.json': 'not json',
    'alice/lk-myasso.json': update({ actor: 'fabien' }),
    '.gitkeep': '',
  });
  await reader({ cacheDir, stateFile, logger: { log() {}, warn: (m) => warnings.push(m) } }).tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state.repos['lk-myasso'].users), ['fabien']);
  assert.equal(warnings.length, 2);
  await rm(root, { recursive: true, force: true });
});

test('a git failure records the error and preserves the previous state', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  await reader({ cacheDir, stateFile }).tick();
  const failing = reader({
    cacheDir, stateFile,
    exec: async () => { throw new Error('fatal: could not read from remote'); },
  });
  await failing.tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.repos['lk-myasso'].users.fabien.runId, 42);
  assert.match(state.lastSyncError, /could not read from remote/);
  await rm(root, { recursive: true, force: true });
});

test('the token never reaches the recorded error message', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const failing = reader({
    cacheDir, stateFile, token: 'ghp_supersecret',
    exec: async () => { throw new Error('failed to clone https://x-access-token:ghp_supersecret@github.com/x.git'); },
  });
  await failing.tick();
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.ok(!state.lastSyncError.includes('ghp_supersecret'));
  assert.match(state.lastSyncError, /\*\*\*/);
  await rm(root, { recursive: true, force: true });
});

test('a second tick is ignored while the first is still running', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  let started = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = reader({
    cacheDir, stateFile,
    exec: async () => { started += 1; await gate; return ''; },
  });
  const first = r.tick();
  await r.tick();
  // The truly concurrent second call must not have started any git command
  // while the first tick is still in flight. This is the assertion that
  // actually proves the lock.
  assert.equal(started, 1);
  release();
  await first;
  // A single completed tick legitimately issues two sequential git calls
  // (fetch then reset), so `started` lands on 2 — not because a second tick
  // ran, but because one real tick does two commands. This guards that it
  // stops at 2, not 3+.
  assert.equal(started, 2);
  await rm(root, { recursive: true, force: true });
});

test('read resolves each repo state and reports repos with no contributor', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  const payload = await r.read(['lk-myasso', 'lk-mind']);
  assert.equal(payload.repos['lk-myasso'].users.fabien.state, 'failure');
  assert.deepEqual(payload.repos['lk-mind'], { users: {} });
  await rm(root, { recursive: true, force: true });
});

test('read falls back to the state keys when no repo list is given', async () => {
  const { root, cacheDir, stateFile } = await fixture();
  const r = reader({ cacheDir, stateFile });
  await r.tick();
  assert.deepEqual(Object.keys((await r.read()).repos), ['lk-myasso']);
  await rm(root, { recursive: true, force: true });
});

test('an unconfigured reader runs no git and marks everything unavailable', async () => {
  const calls = [];
  const r = reader({ statusRepo: null, cacheDir: '/nope', stateFile: '/nope/ci.json' }, calls);
  await r.tick();
  const payload = await r.read(['lk-myasso']);
  assert.equal(calls.length, 0);
  assert.deepEqual(payload.repos['lk-myasso'], { users: {}, unavailable: 'status repo not configured' });
});

test('read tolerates a missing cache file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-reader-'));
  const r = reader({ cacheDir: path.join(root, 'c'), stateFile: path.join(root, 'ci.json') });
  assert.deepEqual((await r.read(['lk-mind'])).repos, { 'lk-mind': { users: {} } });
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx nx run board:test-reader
```

Expected: FAIL — `Cannot find module './ciReader.js'`.

- [ ] **Step 4: Implement**

`apps/board/ciReader.js`:

```js
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defaultExec } from '@ai-sync/git';
import { parseUpdate, buildState, normalizeState } from '@ai-sync/ci-status';

const EMPTY = { version: 1, lastSyncAt: null, lastSyncError: null, repos: {} };

// Read-only consumer of the ci-status branch. It never writes to the branch:
// every board reads every contributor's folder, so a board that also deleted
// would erase updates another board has not read yet.
export function createCiReader({
  statusRepo = null,
  token = null,
  branch = 'ci-status',
  stateFile,
  cacheDir,
  exec = defaultExec,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  let running = false;

  // A git error message embeds the URL we passed it, token and all.
  function redact(message) {
    return token ? String(message).split(token).join('***') : String(message);
  }

  function cloneUrl() {
    if (!token) return statusRepo;
    return statusRepo.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }

  async function syncCheckout() {
    if (!existsSync(path.join(cacheDir, '.git'))) {
      await mkdir(path.dirname(cacheDir), { recursive: true });
      await exec('git', ['clone', '--depth', '1', '--branch', branch, '--single-branch', cloneUrl(), cacheDir], {});
      return;
    }
    await exec('git', ['fetch', '--depth', '1', 'origin', branch], { cwd: cacheDir });
    await exec('git', ['reset', '--hard', `origin/${branch}`], { cwd: cacheDir });
  }

  async function readEntries() {
    const root = path.join(cacheDir, 'updates');
    const logins = await readdir(root).catch(() => []);
    const entries = [];
    for (const login of logins) {
      // A non-directory here (`.gitkeep`) makes readdir throw ENOTDIR: skip it.
      const files = await readdir(path.join(root, login)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const repo = file.slice(0, -'.json'.length);
        const raw = await readFile(path.join(root, login, file), 'utf8');
        const parsed = parseUpdate(raw, { login, repo });
        if (!parsed.ok) {
          logger.warn(`  ⚠ ci: skipping updates/${login}/${file}: ${parsed.reason}`);
          continue;
        }
        entries.push({ login, repo, update: parsed.update });
      }
    }
    return entries;
  }

  async function readState() {
    try {
      return JSON.parse(await readFile(stateFile, 'utf8'));
    } catch {
      return EMPTY;
    }
  }

  async function writeState(state) {
    const tmp = `${stateFile}.tmp`;
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, stateFile);
  }

  async function tick() {
    if (!statusRepo || running) return;
    running = true;
    try {
      await syncCheckout();
      const { repos } = buildState(await readEntries(), now());
      await writeState({ version: 1, lastSyncAt: now(), lastSyncError: null, repos });
    } catch (err) {
      const previous = await readState();
      await writeState({ ...previous, lastSyncError: redact(err.message) });
      logger.warn(`  ⚠ ci: sync failed: ${redact(err.message)}`);
    } finally {
      running = false;
    }
  }

  async function read(names = null) {
    const generatedAt = now();
    if (!statusRepo) {
      const repos = Object.fromEntries(
        (names ?? []).map((n) => [n, { users: {}, unavailable: 'status repo not configured' }]),
      );
      return { generatedAt, lastSyncError: null, repos };
    }
    const state = await readState();
    const wanted = names ?? Object.keys(state.repos ?? {});
    const repos = {};
    for (const name of wanted) {
      const users = state.repos?.[name]?.users ?? {};
      repos[name] = {
        users: Object.fromEntries(
          Object.entries(users).map(([login, run]) => [
            login,
            { state: normalizeState(run.status, run.conclusion), run },
          ]),
        ),
      };
    }
    return { generatedAt, lastSyncError: state.lastSyncError ?? null, repos };
  }

  return { tick, read };
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
npx nx run board:test-reader
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/board/ciReader.js apps/board/ciReader.test.js apps/board/package.json package-lock.json
git commit -m "feat(board): add read-only consumer of the ci-status branch"
```

---

## Task 8: `/api/ci` and the server flags

**Files:**
- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/server.test.js`:

```js
test('GET /api/ci returns the reader payload for the configured repos', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({ repos: [{ name: 'lk-myasso' }, { name: 'lk-mind' }] }));
  const seen = [];
  const ciReader = { read: async (names) => { seen.push(names); return { generatedAt: 'now', lastSyncError: null, repos: {} }; } };
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, configPath, ciReader });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/ci`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { generatedAt: 'now', lastSyncError: null, repos: {} });
  assert.deepEqual(seen[0], ['lk-myasso', 'lk-mind']);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/ci reports unavailable when no reader is wired', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/ci`);
  const body = await res.json();
  assert.deepEqual(body.repos, {});
  assert.equal(body.lastSyncError, 'status repo not configured');
  server.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test-server
```

Expected: FAIL — the `/api/ci` request falls through to the static handler and 404s.

- [ ] **Step 3: Implement the route**

In `apps/board/server.js`, add after `serveConfig`:

```js
// The repo list comes from the config, which is where repo identity lives; the
// reader only knows about names that have reported.
async function readRepoNames(configPath) {
  if (!configPath) return null;
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    return (parsed.repos ?? []).map((r) => r?.name).filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function serveCi(ciReader, configPath, res) {
  const body = ciReader
    ? await ciReader.read(await readRepoNames(configPath))
    : { generatedAt: new Date().toISOString(), lastSyncError: 'status repo not configured', repos: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
```

Then extend the factory signature and the router:

```js
export function createBoardServer({ boardPath, distDir, configPath = null, ciReader = null }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      if (url.pathname === '/api/config') return await serveConfig(configPath, res);
      if (url.pathname === '/api/ci') return await serveCi(ciReader, configPath, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test-server
```

Expected: PASS.

- [ ] **Step 5: Wire the reader into `startFromArgv`**

Add `createCiReader` to the imports:

```js
import { createCiReader } from './ciReader.js';
```

Extend the `parseArgs` options:

```js
      board: { type: 'string' }, port: { type: 'string', default: '4180' },
      dist: { type: 'string' }, config: { type: 'string' },
      'status-repo': { type: 'string' }, 'ci-interval': { type: 'string', default: '60' },
      'ci-state': { type: 'string' }, 'ci-cache': { type: 'string' },
```

Then, just before `const distDir = …`, build the reader and start its timer:

```js
  const boardDir = path.dirname(boardPath);
  const statusRepo = values['status-repo'] ?? process.env.AI_SYNC_STATUS_REPO ?? null;
  const ciReader = createCiReader({
    statusRepo,
    token: process.env.AI_SYNC_STATUS_TOKEN ?? null,
    stateFile: values['ci-state'] ? path.resolve(values['ci-state']) : path.join(boardDir, 'ci.json'),
    cacheDir: values['ci-cache'] ? path.resolve(values['ci-cache']) : path.join(boardDir, 'ci-status'),
    logger: { log, warn: log },
  });
  if (statusRepo) {
    log(`  ci status from ${statusRepo} (${values['ci-interval']}s)`);
    void ciReader.tick();
  }
```

Pass it to the factory:

```js
  const server = createBoardServer({ boardPath, distDir, configPath, ciReader });
```

and start the interval once the server is listening, clearing it on close:

```js
  const ciTimer = statusRepo ? setInterval(() => void ciReader.tick(), Number(values['ci-interval']) * 1000) : null;
  server.on('close', () => { if (ciTimer) clearInterval(ciTimer); });
```

Place these two lines immediately before the existing `server.on('listening', …)` registration.

- [ ] **Step 6: Run the whole board suite**

```bash
npx nx run board:test
```

Expected: PASS — server, reader and Vitest suites.

- [ ] **Step 7: Commit**

```bash
git add apps/board/server.js apps/board/server.test.js
git commit -m "feat(board): serve /api/ci and poll the ci-status branch"
```

---

## Task 9: Badge presentation helpers

**Files:**
- Create: `apps/board/src/ciBadge.js`
- Create: `apps/board/src/ciBadge.test.js`

- [ ] **Step 1: Write the failing test**

`apps/board/src/ciBadge.test.js`:

```js
import { test, expect } from 'vitest';
import { initials, visibleBadges, pillClass, ciAggregate, matchesCiFilter } from './ciBadge.js';

test('initials handles single names, separators and empties', () => {
  expect(initials('fabien')).toBe('FA');
  expect(initials('jean-luc')).toBe('JL');
  expect(initials('mary_ann_smith')).toBe('MA');
  expect(initials('a')).toBe('A');
  expect(initials('')).toBe('?');
});

test('visibleBadges sorts worst first and breaks ties by login', () => {
  const users = {
    zoe: { state: 'success' }, alice: { state: 'failure' },
    bob: { state: 'running' }, carl: { state: 'neutral' }, amy: { state: 'failure' },
  };
  const { shown, overflow } = visibleBadges(users);
  expect(shown.map((b) => b.login)).toEqual(['alice', 'amy', 'bob', 'carl']);
  expect(overflow.map((b) => b.login)).toEqual(['zoe']);
  expect(shown[0].initials).toBe('AL');
});

test('visibleBadges returns no overflow at or below the cap', () => {
  const { shown, overflow } = visibleBadges({ a: { state: 'success' } });
  expect(shown).toHaveLength(1);
  expect(overflow).toEqual([]);
});

test('visibleBadges tolerates an absent users map', () => {
  expect(visibleBadges(undefined)).toEqual({ shown: [], overflow: [] });
});

test('pillClass colours each state and falls back to neutral', () => {
  expect(pillClass('failure')).toContain('red');
  expect(pillClass('running')).toContain('animate-pulse');
  expect(pillClass('success')).toContain('emerald');
  expect(pillClass('neutral')).toContain('slate');
  expect(pillClass('bogus')).toBe(pillClass('neutral'));
});

test('ciAggregate reduces contributors to one verdict', () => {
  expect(ciAggregate({})).toBe('unknown');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'failure' } })).toBe('failure');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'running' } })).toBe('running');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'neutral' } })).toBe('ok');
});

test('matchesCiFilter implements the three filter options', () => {
  const failing = { a: { state: 'failure' } };
  const green = { a: { state: 'success' } };
  expect(matchesCiFilter(failing, '')).toBe(true);
  expect(matchesCiFilter(failing, 'failure')).toBe(true);
  expect(matchesCiFilter(green, 'failure')).toBe(false);
  expect(matchesCiFilter(green, 'ok')).toBe(true);
  expect(matchesCiFilter({ a: { state: 'running' } }, 'ok')).toBe(false);
  expect(matchesCiFilter({}, 'unknown')).toBe(true);
  expect(matchesCiFilter(green, 'unknown')).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — `Failed to resolve import './ciBadge.js'`.

- [ ] **Step 3: Implement**

`apps/board/src/ciBadge.js`:

```js
import { rankState } from '@ai-sync/ci-status';

const MAX_BADGES = 4;

const PILL = {
  failure: 'bg-red-100 text-red-700 border-red-300',
  running: 'bg-blue-100 text-blue-700 border-blue-300 animate-pulse',
  neutral: 'bg-slate-100 text-slate-600 border-slate-300',
  success: 'bg-emerald-100 text-emerald-700 border-emerald-300',
};

export function initials(login) {
  const parts = login.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function pillClass(state) {
  return PILL[state] ?? PILL.neutral;
}

// Worst first, so a failure is always among the badges that survive the cap.
export function visibleBadges(users, max = MAX_BADGES) {
  const all = Object.entries(users ?? {})
    .map(([login, u]) => ({ login, state: u.state, initials: initials(login) }))
    .sort((a, b) => rankState(a.state) - rankState(b.state) || a.login.localeCompare(b.login));
  return { shown: all.slice(0, max), overflow: all.slice(max) };
}

export function ciAggregate(users) {
  const states = Object.values(users ?? {}).map((u) => u.state);
  if (states.length === 0) return 'unknown';
  if (states.includes('failure')) return 'failure';
  if (states.includes('running')) return 'running';
  return 'ok';
}

export function matchesCiFilter(users, filter) {
  if (!filter) return true;
  return ciAggregate(users) === filter;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/ciBadge.js apps/board/src/ciBadge.test.js
git commit -m "feat(board): add CI badge ordering, initials and filter helpers"
```

---

## Task 10: Contributor badges on the card

**Files:**
- Modify: `apps/board/src/Card.vue`
- Test: `apps/board/src/Card.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/Card.test.js`:

```js
const repoTodo = { status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T09:59:00.000Z' };

test('renders one badge per contributor, worst first', () => {
  const ci = { users: { zoe: { state: 'success' }, alice: { state: 'failure' } } };
  const w = mount(Card, { props: { name: 'oc-be', repo: repoTodo, now, ci } });
  const badges = w.findAll('[data-test=ci-badge]');
  expect(badges.map((b) => b.text())).toEqual(['AL', 'ZO']);
  expect(badges[0].classes().join(' ')).toContain('red');
});

test('collapses beyond four contributors into a +N badge', () => {
  const users = {};
  for (const login of ['a1', 'b2', 'c3', 'd4', 'e5']) users[login] = { state: 'success' };
  const w = mount(Card, { props: { name: 'oc-be', repo: repoTodo, now, ci: { users } } });
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(4);
  expect(w.get('[data-test=ci-overflow]').text()).toBe('+1');
});

test('renders no badges when the repo has no CI status', () => {
  const w = mount(Card, { props: { name: 'oc-be', repo: repoTodo, now } });
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(0);
  expect(w.find('[data-test=ci-overflow]').exists()).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — no `[data-test=ci-badge]` elements found.

- [ ] **Step 3: Implement**

Replace `apps/board/src/Card.vue` entirely:

```vue
<script setup>
import { computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import { visibleBadges, pillClass } from './ciBadge.js';

const props = defineProps({
  name: { type: String, required: true },
  repo: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: null },
});
defineEmits(['open']);

const isQuestion = computed(() => props.repo.status === 'question');
const when = computed(() => relativeTime(props.repo.updatedAt, props.now));
const badges = computed(() => visibleBadges(props.ci?.users));
const overflowTitle = computed(() => badges.value.overflow.map((b) => `${b.login} — ${b.state}`).join('\n'));
</script>

<template>
  <button
    type="button"
    @click="$emit('open', name)"
    :class="['w-full text-left rounded-md bg-white shadow-sm border p-3 transition',
             isQuestion ? 'border-amber-400 ring-4 ring-amber-200' : 'border-slate-200 hover:border-slate-300']"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="font-medium text-slate-800 min-w-0 truncate">{{ name }}</div>
      <div class="flex items-center gap-1 shrink-0">
        <span
          v-for="b in badges.shown" :key="b.login"
          data-test="ci-badge"
          :title="`${b.login} — ${b.state}`"
          :class="['text-[10px] leading-none font-semibold border rounded px-1 py-0.5', pillClass(b.state)]"
        >{{ b.initials }}</span>
        <span
          v-if="badges.overflow.length"
          data-test="ci-overflow"
          :title="overflowTitle"
          class="text-[10px] leading-none font-semibold border border-slate-300 bg-slate-100 text-slate-500 rounded px-1 py-0.5"
        >+{{ badges.overflow.length }}</span>
      </div>
    </div>
    <div class="mt-1 text-xs text-slate-500">{{ repo.lastEvent }} · {{ when }}</div>
  </button>
</template>
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS — including the three pre-existing Card tests.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/Card.vue apps/board/src/Card.test.js
git commit -m "feat(board): show a CI badge per contributor on each card"
```

---

## Task 11: Relay the `ci` prop through `Column`

**Files:**
- Modify: `apps/board/src/Column.vue`
- Test: `apps/board/src/Card.test.js` (Column has no test file; add one)
- Create: `apps/board/src/Column.test.js`

- [ ] **Step 1: Write the failing test**

`apps/board/src/Column.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Column from './Column.vue';

const repo = { status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T09:59:00.000Z' };
const now = Date.parse('2026-06-21T10:00:00.000Z');

test('passes each entry its own CI status', () => {
  const w = mount(Column, {
    props: {
      title: 'To do', entries: [{ name: 'oc-be', repo }], now,
      ci: { 'oc-be': { users: { alice: { state: 'failure' } } } },
    },
  });
  expect(w.get('[data-test=ci-badge]').text()).toBe('AL');
});

test('renders cards unharmed when no CI map is given', () => {
  const w = mount(Column, { props: { title: 'To do', entries: [{ name: 'oc-be', repo }], now } });
  expect(w.text()).toContain('oc-be');
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — no badge rendered, because `Column` drops the prop.

- [ ] **Step 3: Implement**

In `apps/board/src/Column.vue`, add the prop:

```js
  ci: { type: Object, default: () => ({}) },
```

and pass it in the template's `<Card …>`:

```html
      <Card v-for="e in entries" :key="e.name" :name="e.name" :repo="e.repo" :now="now" :ci="ci[e.name] ?? null" @open="$emit('open', $event)" />
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/Column.vue apps/board/src/Column.test.js
git commit -m "feat(board): relay per-repo CI status through the column"
```

---

## Task 12: CI block in the detail panel

**Files:**
- Modify: `apps/board/src/RepoDetail.vue`
- Test: `apps/board/src/RepoDetail.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/RepoDetail.test.js`:

```js
const nowTs = Date.parse('2026-07-29T10:00:00.000Z');

test('lists each contributor CI run with a link to it', () => {
  const ci = { users: { fabien: { state: 'failure', run: {
    workflow: 'CI', branch: 'feat/x', conclusion: 'failure',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/42',
    startedAt: '2026-07-29T09:59:00.000Z',
  } } } };
  const w = mount(RepoDetail, { props: { name: 'lk-myasso', repo: null, meta: null, now: nowTs, ci } });
  const line = w.get('[data-test=ci-user]');
  expect(line.text()).toContain('fabien');
  expect(line.text()).toContain('CI');
  expect(line.text()).toContain('feat/x');
  expect(w.get('[data-test=ci-link]').attributes('href')).toBe('https://github.com/linktogo/lk-myasso/actions/runs/42');
});

test('shows the reason instead of the list when CI is unavailable', () => {
  const ci = { users: {}, unavailable: 'status repo not configured' };
  const w = mount(RepoDetail, { props: { name: 'lk-myasso', repo: null, meta: null, now: nowTs, ci } });
  expect(w.get('[data-test=ci-unavailable]').text()).toContain('status repo not configured');
  expect(w.findAll('[data-test=ci-user]')).toHaveLength(0);
});

test('says nothing has been reported when no contributor has run CI', () => {
  const w = mount(RepoDetail, { props: { name: 'lk-myasso', repo: null, meta: null, now: nowTs, ci: { users: {} } } });
  expect(w.get('[data-test=ci-empty]').text()).toContain('Aucun statut');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — no `[data-test=ci-user]` element.

- [ ] **Step 3: Implement**

In `apps/board/src/RepoDetail.vue`, extend the script block:

```js
import { onMounted, onUnmounted, computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import { visibleBadges, pillClass } from './ciBadge.js';

const props = defineProps({
  name: { type: String, default: null },
  repo: { type: Object, default: null },
  meta: { type: Object, default: null },
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: null },
});
const emit = defineEmits(['close']);

const ciUsers = computed(() => visibleBadges(props.ci?.users, Infinity).shown);

function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
```

Note the existing file uses `defineProps(...)` without assigning it — the block
above replaces that with `const props = defineProps(...)`, which the computed
needs.

Insert this block in the template, immediately before the `<h3>Historique</h3>`
line:

```html
      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">Intégration continue</h3>
      <p v-if="ci?.unavailable" data-test="ci-unavailable" class="mt-1 text-xs text-slate-500">
        Indisponible — {{ ci.unavailable }}
      </p>
      <p v-else-if="ciUsers.length === 0" data-test="ci-empty" class="mt-1 text-xs text-slate-500">
        Aucun statut remonté.
      </p>
      <ul v-else class="mt-1 space-y-1">
        <li v-for="u in ciUsers" :key="u.login" data-test="ci-user" class="text-xs text-slate-600">
          <span :class="['border rounded px-1 py-0.5 mr-1 font-semibold', pillClass(u.state)]">{{ u.initials }}</span>
          <b>{{ u.login }}</b> ·
          <a data-test="ci-link" :href="ci.users[u.login].run.url" target="_blank" rel="noopener" class="text-blue-600 underline">
            {{ ci.users[u.login].run.workflow }}
          </a>
          · {{ ci.users[u.login].run.branch }}
          · {{ ci.users[u.login].run.conclusion }}
          · {{ relativeTime(ci.users[u.login].run.startedAt, now) }}
        </li>
      </ul>
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS, including the pre-existing RepoDetail tests.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/RepoDetail.vue apps/board/src/RepoDetail.test.js
git commit -m "feat(board): break CI status down per contributor in the detail panel"
```

---

## Task 13: The `useCi` composable

**Files:**
- Create: `apps/board/src/useCi.js`
- Create: `apps/board/src/useCi.test.js`

- [ ] **Step 1: Write the failing test**

`apps/board/src/useCi.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useCi } from './useCi.js';

function respond(body) {
  return vi.fn().mockResolvedValue({ json: async () => body });
}

test('useCi fetches immediately and exposes repos', async () => {
  const fetchImpl = respond({ repos: { a: { users: { alice: { state: 'failure' } } } }, lastSyncError: null });
  const { repos, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/ci');
  expect(repos.value.a.users.alice.state).toBe('failure');
  stop();
});

test('useCi polls on the interval', async () => {
  vi.useFakeTimers();
  const fetchImpl = respond({ repos: {} });
  const { stop } = useCi({ intervalMs: 500, fetchImpl });
  await vi.advanceTimersByTimeAsync(1100);
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
  stop();
  vi.useRealTimers();
});

test('useCi surfaces the server-reported sync error', async () => {
  const fetchImpl = respond({ repos: {}, lastSyncError: 'could not read from remote' });
  const { syncError, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  expect(syncError.value).toBe('could not read from remote');
  stop();
});

test('useCi keeps the last known repos when a fetch fails', async () => {
  const responses = [{ repos: { a: { users: {} } }, lastSyncError: null }];
  const fetchImpl = vi.fn()
    .mockImplementationOnce(() => Promise.resolve({ json: async () => responses[0] }))
    .mockImplementationOnce(() => Promise.reject(new Error('down')));
  const { repos, syncError, refresh, stop } = useCi({ intervalMs: 100000, fetchImpl });
  await nextTick(); await Promise.resolve(); await nextTick();
  await refresh();
  expect(repos.value).toEqual({ a: { users: {} } });
  expect(syncError.value).toBe('injoignable');
  stop();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — `Failed to resolve import './useCi.js'`.

- [ ] **Step 3: Implement**

`apps/board/src/useCi.js`:

```js
import { ref, onUnmounted } from 'vue';

export function useCi({ intervalMs = 30000, fetchImpl = fetch } = {}) {
  const repos = ref({});
  const syncError = ref(null);

  async function refresh() {
    try {
      const res = await fetchImpl('/api/ci');
      const data = await res.json();
      repos.value = data.repos ?? {};
      syncError.value = data.lastSyncError ?? null;
    } catch {
      // Keep the last known statuses: a dead poll is not evidence CI changed.
      syncError.value = 'injoignable';
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  function stop() { clearInterval(timer); }
  onUnmounted(stop);

  return { repos, syncError, refresh, stop };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useCi.js apps/board/src/useCi.test.js
git commit -m "feat(board): poll /api/ci from the client"
```

---

## Task 14: CI filter in the filter bar

**Files:**
- Modify: `apps/board/src/FilterBar.vue`
- Test: `apps/board/src/FilterBar.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/FilterBar.test.js`:

```js
test('offers the three CI filters and emits the selection', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', ci: '', technologies: [] } });
  const options = w.get('[data-test=ci]').findAll('option').map((o) => o.text());
  expect(options).toEqual(['CI : tous', 'en échec', 'OK', 'inconnu']);
  await w.get('[data-test=ci]').setValue('failure');
  expect(w.emitted('update:ci')[0]).toEqual(['failure']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — no `[data-test=ci]` element.

- [ ] **Step 3: Implement**

In `apps/board/src/FilterBar.vue`, add `ci: { type: String, default: '' }` to
`defineProps` and `'update:ci'` to `defineEmits`, then add this `<select>`
after the technology one:

```html
    <select
      data-test="ci"
      :value="ci"
      @change="$emit('update:ci', $event.target.value)"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white text-slate-600"
    >
      <option value="">CI : tous</option>
      <option value="failure">en échec</option>
      <option value="ok">OK</option>
      <option value="unknown">inconnu</option>
    </select>
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx nx run board:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/FilterBar.vue apps/board/src/FilterBar.test.js
git commit -m "feat(board): add a CI filter to the filter bar"
```

---

## Task 15: Wire it all together in `App.vue`

**Files:**
- Modify: `apps/board/src/App.vue`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Write the failing test**

Append to `apps/board/src/App.test.js`. Reuse the file's existing `settle()`
helper; add a second stub factory next to `routedFetch` rather than changing it,
so the four existing tests keep their fixture untouched:

```js
function ciRoutedFetch({ board = { version: 1, repos: {} }, ci = { repos: {}, lastSyncError: null } }) {
  return vi.fn().mockImplementation((url) => {
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/ci') return Promise.resolve({ json: async () => ci });
    return Promise.resolve({ json: async () => board });
  });
}

const CARD = { status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T09:59:00.000Z', events: [] };

test('renders CI badges coming from /api/ci', async () => {
  const fetchImpl = ciRoutedFetch({
    board: { version: 1, repos: { 'oc-be': CARD } },
    ci: { repos: { 'oc-be': { users: { alice: { state: 'failure' } } } }, lastSyncError: null },
  });
  const w = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
  expect(w.get('[data-test=ci-badge]').text()).toBe('AL');
});

test('the CI filter hides repos that do not match', async () => {
  const fetchImpl = ciRoutedFetch({
    board: { version: 1, repos: { 'repo-green': CARD, 'repo-red': CARD } },
    ci: { repos: {
      'repo-green': { users: { alice: { state: 'success' } } },
      'repo-red': { users: { alice: { state: 'failure' } } },
    }, lastSyncError: null },
  });
  const w = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
  await w.get('[data-test=ci]').setValue('failure');
  await nextTick();
  expect(w.text()).toContain('repo-red');
  expect(w.text()).not.toContain('repo-green');
});

test('shows a desync banner when the server reports a sync error', async () => {
  const fetchImpl = ciRoutedFetch({ ci: { repos: {}, lastSyncError: 'could not read from remote' } });
  const w = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
  expect(w.get('[data-test=ci-desync]').text()).toContain('désynchronisé');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx nx run board:test
```

Expected: FAIL — no badge, no `[data-test=ci]`, no banner.

- [ ] **Step 3: Implement**

In `apps/board/src/App.vue`:

Add the imports:

```js
import { useCi } from './useCi.js';
import { matchesCiFilter } from './ciBadge.js';
```

After the `useConfig` line, add:

```js
const { repos: ci, syncError: ciError } = useCi({ fetchImpl });
```

Add the filter ref next to the existing ones:

```js
const ciFilter = ref('');
```

Extend the `filtered` computed with a third guard, after the technology one:

```js
    if (!matchesCiFilter(ci.value[name]?.users, ciFilter.value)) continue;
```

Add the selected repo's CI status next to `selectedMeta`:

```js
const selectedCi = computed(() => (selected.value ? ci.value[selected.value] ?? null : null));
```

In the template, extend the `FilterBar` binding:

```html
        <FilterBar
          :name="nameFilter" :tech="techFilter" :ci="ciFilter" :technologies="technologies"
          @update:name="nameFilter = $event" @update:tech="techFilter = $event" @update:ci="ciFilter = $event"
        />
```

Add the banner next to the existing `!connected` one:

```html
    <p v-if="ciError" data-test="ci-desync" class="mb-3 text-xs text-amber-700">⚠ CI désynchronisé — {{ ciError }}</p>
```

Pass `ci` to each column:

```html
      <Column
        v-for="c in grouped" :key="c.status"
        :title="c.title" :accent="c.accent" :entries="c.entries" :now="now" :ci="ci"
        @open="selected = $event"
      />
```

and to the detail panel:

```html
    <RepoDetail
      :name="selected" :repo="selectedRepo" :meta="selectedMeta" :ci="selectedCi" :now="now"
      @close="selected = null"
    />
```

- [ ] **Step 4: Run the whole suite**

```bash
npx nx run-many -t test && npx nx run-many -t lint && npx nx run-many -t build
```

Expected: all green, 9 projects.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/App.test.js
git commit -m "feat(board): wire CI status into the board, filter and detail panel"
```

---

## Task 16: Document the setup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a `CI status on the board` section**

Insert it after the board section of `README.md`:

````markdown
## CI status on the board

Each board card shows one badge per contributor, coloured by that person's
latest CI outcome for the repo. Managed repos push their status; the board only
reads.

### 1. Seed the drop branch (once, in this repository)

```sh
git checkout --orphan ci-status
git rm -rf .
mkdir updates && touch updates/.gitkeep
git add -A && git commit -m "chore: seed ci-status drop branch"
git push -u origin ci-status
git checkout main
```

### 2. Report from each managed repo

Create an `AI_SYNC_STATUS_TOKEN` secret in the repo — a fine-grained token with
**Contents: write** on `linktogo/ai-sync` — then add
`.github/workflows/ai-sync-status.yml`:

```yaml
name: ai-sync status
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: linktogo/ai-sync/.github/actions/ci-status-report@main
        with:
          token: ${{ secrets.AI_SYNC_STATUS_TOKEN }}
```

Alternatively, drop the same `uses:` block as a final `if: always()` step in an
existing CI job. The `workflow_run` form is preferred: it sees the conclusion of
the whole workflow, including `cancelled`, and leaves the existing CI file
untouched.

### 3. Point the board at the branch

```sh
AI_SYNC_STATUS_REPO=https://github.com/linktogo/ai-sync.git npm start
```

| Flag | Env | Default |
|---|---|---|
| `--status-repo` | `AI_SYNC_STATUS_REPO` | none — CI status disabled |
| — | `AI_SYNC_STATUS_TOKEN` | none — uses ambient git credentials |
| `--ci-interval` | — | `60` (seconds) |
| `--ci-state` | — | `<board dir>/ci.json` |
| `--ci-cache` | — | `<board dir>/ci-status` |

Statuses never expire. A contributor who leaves the team keeps a badge until
their file is removed from `updates/<login>/` by hand.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document CI status setup for the board"
```

---

## Task 17: Final verification

- [ ] **Step 1: Full workspace check**

```bash
npx nx run-many -t lint && npx nx run-many -t test && npx nx run-many -t build
```

Expected: 9 projects green. `ci-status` reports 100% lines/functions/branches.

- [ ] **Step 2: Confirm the coverage gate is actually enforced**

```bash
npx nx run ci-status:test --skip-nx-cache 2>&1 | grep -E "all files|lines|branches"
```

Expected: 100 across the board. If Nx served a cached result, the gate was not
re-run — `--skip-nx-cache` is what forces it.

- [ ] **Step 3: Push**

```bash
git push -u origin claude/github-workflow-ci-dashboard-8fgt17
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: `libs/ci-status` exports →
Tasks 2–5; composite action and both trigger forms → Task 6 and Task 16;
read-only consumer, redaction, in-flight lock, atomic write → Task 7;
`/api/ci`, config, flags → Task 8; badges, detail block, filter semantics →
Tasks 9–15; orphan-branch prerequisite and the no-expiry limitation → Task 16;
non-force push → Task 1.

**Two additions the spec did not anticipate.** `libs/git` needed `fetchReset`
and `configureIdentity` for the action's retry loop, and `clone` needed a
`branch` option — all three are added under test in Task 6. `apps/board` needed
a `test-reader` Nx target so `ciReader.test.js` runs under `node --test` like
`server.test.js` does; that is Task 7 Step 1.

**Existing tests that must keep passing unchanged.** `App.test.js` mounts with
its own `routedFetch()` stub, which returns the board payload for any path it
does not recognise — including `/api/ci`. `useCi` will therefore receive a board
payload there, find no `repos[name].users`, and render no badges: the four
existing tests are unaffected, which is why Task 15 adds a second stub factory
instead of editing `routedFetch`. `RepoDetail.test.js` asserts on `w.get('a')`;
the CI block is inserted *after* the meta URL link, so that first `<a>` is still
the repo URL.

**Signatures pinned across tasks.** `normalizeState(status, conclusion)`,
`rankState(state)`, `parseUpdate(raw, {login, repo})`,
`buildUpdate(env, event, now)`, `buildState(entries, now)`,
`createCiReader({…}).tick()/.read(names)`, `visibleBadges(users, max)`,
`pillClass(state)`, `ciAggregate(users)`, `matchesCiFilter(users, filter)`,
`useCi({intervalMs, fetchImpl})` → `{repos, syncError, refresh, stop}`.
