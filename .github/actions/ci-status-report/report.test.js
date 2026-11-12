import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const reportPath = fileURLToPath(new URL('./report.js', import.meta.url));

async function makeStatusRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-status-report-git-'));
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '--bare', bare]);
  execFileSync('git', ['clone', bare, seed]);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', seed, 'checkout', '--orphan', 'ci-status']);
  await mkdir(path.join(seed, 'updates'), { recursive: true });
  await writeFile(path.join(seed, 'updates', '.gitkeep'), '');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'init ci-status']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'HEAD:ci-status']);
  return { root, bare };
}

async function cloneStatusRepo(root, bare) {
  const dest = path.join(root, `verify-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '--branch', 'ci-status', '--single-branch', bare, dest]);
  return dest;
}

function baseEnv({ statusRepo, token, branch = 'ci-status', runId = '42' } = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    INPUT_TOKEN: token ?? 'sekrit-token-abc123',
    INPUT_STATUS_REPO: statusRepo,
    INPUT_BRANCH: branch,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'linktogo/lk-myasso',
    GITHUB_ACTOR: 'fabien',
    GITHUB_RUN_ID: runId,
    GITHUB_WORKFLOW: 'CI',
    GITHUB_REF_NAME: 'main',
    GITHUB_SERVER_URL: 'https://github.com',
    JOB_STATUS: 'success',
  };
}

function runReport(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [reportPath], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function tempCloneDirs() {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith('maggie-status-'));
}

test('a deposit writes updates/<login>/<repo>.json on the ci-status branch', async () => {
  const { root, bare } = await makeStatusRepo();
  const env = baseEnv({ statusRepo: bare });

  const result = await runReport(env);
  assert.equal(result.code, 0, result.stderr);

  const verify = await cloneStatusRepo(root, bare);
  const raw = await readFile(path.join(verify, 'updates', 'fabien', 'lk-myasso.json'), 'utf8');
  const update = JSON.parse(raw);
  assert.equal(update.repo, 'lk-myasso');
  assert.equal(update.actor, 'fabien');
  assert.equal(update.runId, 42);
  assert.equal(update.status, 'completed');
  assert.equal(update.conclusion, 'success');
  assert.equal(update.workflow, 'CI');
  assert.equal(update.branch, 'main');
  assert.equal(update.event, 'push');
  assert.equal(update.url, 'https://github.com/linktogo/lk-myasso/actions/runs/42');
});

test('a failed deposit removes the temp clone instead of leaving the token on disk', async () => {
  const { root } = await makeStatusRepo();
  const token = 'sekrit-token-def456';
  const missing = path.join(root, `does-not-exist-${token}`);
  const env = baseEnv({ statusRepo: missing, token });

  const before = await tempCloneDirs();
  const result = await runReport(env);
  const after = await tempCloneDirs();

  assert.equal(result.code, 1);
  const createdByThisRun = after.filter((name) => !before.includes(name));
  assert.deepEqual(createdByThisRun, []);
});

test('the token never appears in the output of a failed deposit', async () => {
  const { root } = await makeStatusRepo();
  const token = 'sekrit-token-ghi789';
  const missing = path.join(root, `does-not-exist-${token}`);
  const env = baseEnv({ statusRepo: missing, token });

  const result = await runReport(env);

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, new RegExp(token));
  assert.doesNotMatch(result.stderr, new RegExp(token));
  assert.match(result.stderr, /\*\*\*/);
});

test('a run older than the one already reported is skipped', async () => {
  const { root, bare } = await makeStatusRepo();

  const seed = await cloneStatusRepo(root, bare);
  const newerUpdate = {
    repo: 'lk-myasso', actor: 'fabien', runId: 999, status: 'completed', conclusion: 'failure',
    workflow: 'CI', branch: 'main', event: 'push',
    url: 'https://github.com/linktogo/lk-myasso/actions/runs/999',
    startedAt: '2026-07-01T00:00:00.000Z', sentAt: '2026-07-01T00:00:00.000Z',
  };
  await mkdir(path.join(seed, 'updates', 'fabien'), { recursive: true });
  await writeFile(path.join(seed, 'updates', 'fabien', 'lk-myasso.json'), `${JSON.stringify(newerUpdate, null, 2)}\n`);
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, 'commit', '-m', 'seed newer run']);
  execFileSync('git', ['-C', seed, 'push', 'origin', 'ci-status']);
  const shaBefore = execFileSync('git', ['-C', seed, 'rev-parse', 'ci-status']).toString().trim();

  const env = baseEnv({ statusRepo: bare, runId: '42' });
  const result = await runReport(env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /already reported, skipping/);

  const shaAfter = execFileSync('git', ['-C', seed, 'ls-remote', bare, 'refs/heads/ci-status']).toString().trim();
  assert.match(shaAfter, new RegExp(shaBefore));

  const verify = await cloneStatusRepo(root, bare);
  const raw = await readFile(path.join(verify, 'updates', 'fabien', 'lk-myasso.json'), 'utf8');
  assert.equal(JSON.parse(raw).runId, 999);
});

test('report.js imports the libs by relative path so the runner needs no npm install', async () => {
  const source = await readFile(reportPath, 'utf8');
  assert.doesNotMatch(source, /from ['"]@linktogo\//);
});

// A pre-receive hook on the bare repo that rejects the first `rejections`
// pushes, as a concurrent deposit winning the race would.
async function rejectPushes(root, bare, rejections) {
  const counter = path.join(root, 'rejections');
  await writeFile(counter, '0');
  const hook = path.join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
n=$(cat "${counter}")
if [ "$n" -lt ${rejections} ]; then echo $((n + 1)) > "${counter}"; echo "rejected" >&2; exit 1; fi
exit 0
`);
  await chmod(hook, 0o755);
}

test('a workflow_run event reports the watched run, its status standing in for a missing conclusion', async () => {
  const { root, bare } = await makeStatusRepo();
  const eventPath = path.join(root, 'event.json');
  await writeFile(eventPath, JSON.stringify({
    workflow_run: {
      id: 77, status: 'in_progress', conclusion: null, name: 'E2E', head_branch: 'feat/x', event: 'pull_request',
      html_url: 'https://github.com/linktogo/lk-myasso/actions/runs/77', run_started_at: '2026-07-01T00:00:00.000Z',
      actor: { login: 'alice' },
    },
  }));
  const result = await runReport({ ...baseEnv({ statusRepo: bare }), GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath });
  assert.equal(result.code, 0, result.stderr);
  const verify = await cloneStatusRepo(root, bare);
  const update = JSON.parse(await readFile(path.join(verify, 'updates', 'alice', 'lk-myasso.json'), 'utf8'));
  assert.equal(update.runId, 77);
  assert.equal(update.conclusion, null);
  const subject = execFileSync('git', ['-C', verify, 'log', '-1', '--format=%s']).toString().trim();
  assert.equal(subject, 'chore(ci-status): alice/lk-myasso in_progress');
});

test('an unreadable event file is ignored and the job itself is reported', async () => {
  const { root, bare } = await makeStatusRepo();
  const eventPath = path.join(root, 'event.json');
  await writeFile(eventPath, '{not json');
  const result = await runReport({ ...baseEnv({ statusRepo: bare }), GITHUB_EVENT_PATH: eventPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /reported updates\/fabien\/lk-myasso\.json/);
});

// Pins the child's clock, so two reports of the same run are byte-identical.
const FROZEN_CLOCK = `--import=data:text/javascript,${encodeURIComponent(
  'const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [0])); } static now() { return 0; } };',
)}`;

test('a newer run replaces an older one, and reporting the same run again pushes nothing', async () => {
  const { root, bare } = await makeStatusRepo();
  const env = (runId) => ({ ...baseEnv({ statusRepo: bare, runId }), NODE_OPTIONS: FROZEN_CLOCK });
  assert.equal((await runReport(env('41'))).code, 0);
  const newer = await runReport(env('42'));
  assert.equal(newer.code, 0, newer.stderr);
  const again = await runReport(env('42'));
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /status unchanged, nothing to push/);
  const verify = await cloneStatusRepo(root, bare);
  assert.equal(JSON.parse(await readFile(path.join(verify, 'updates', 'fabien', 'lk-myasso.json'), 'utf8')).runId, 42);
});

test('a malformed file already on the branch is overwritten', async () => {
  const { root, bare } = await makeStatusRepo();
  const seed = await cloneStatusRepo(root, bare);
  await mkdir(path.join(seed, 'updates', 'fabien'), { recursive: true });
  await writeFile(path.join(seed, 'updates', 'fabien', 'lk-myasso.json'), '{garbage');
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t.dev', '-c', 'user.name=T', 'commit', '-qm', 'garbage']);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'ci-status']);
  const result = await runReport(baseEnv({ statusRepo: bare }));
  assert.equal(result.code, 0, result.stderr);
  const verify = await cloneStatusRepo(root, bare);
  assert.equal(JSON.parse(await readFile(path.join(verify, 'updates', 'fabien', 'lk-myasso.json'), 'utf8')).runId, 42);
});

test('a rejected push is retried on top of the refreshed branch', async () => {
  const { root, bare } = await makeStatusRepo();
  await rejectPushes(root, bare, 1);
  const result = await runReport(baseEnv({ statusRepo: bare }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /push rejected \(attempt 1\/5\), retrying/);
  assert.match(result.stdout, /reported updates\/fabien\/lk-myasso\.json/);
});

test('a push rejected on every attempt fails the step', async () => {
  const { root, bare } = await makeStatusRepo();
  await rejectPushes(root, bare, 5);
  const result = await runReport(baseEnv({ statusRepo: bare }));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /attempt 4\/5/);
  assert.doesNotMatch(result.stdout, /attempt 5\/5/);
});
