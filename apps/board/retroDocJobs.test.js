import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRetroDocRunner, resolveCheckout } from './retroDocJobs.js';

/** A workspace the way `maggie-workspace` leaves it: wk/<repo>, wk/.maggie/board.json. */
async function workspace(repos) {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-retro-'));
  const workspaceDir = path.join(dir, 'wk');
  for (const repo of repos) await mkdir(path.join(workspaceDir, repo), { recursive: true });
  await mkdir(path.join(workspaceDir, '.maggie'), { recursive: true });
  return { dir, workspaceDir, boardPath: path.join(workspaceDir, '.maggie', 'board.json') };
}

const CONFIG = { repos: [{ name: 'api' }, { name: 'web' }] };

test('resolveCheckout follows the same rule as hook reconciliation', () => {
  const boardPath = '/home/me/wk/.maggie/board.json';
  assert.equal(resolveCheckout({ boardPath, config: CONFIG, repo: 'api' }), path.join('/home/me/wk', 'api'));
  assert.equal(
    resolveCheckout({ boardPath, config: { repos: [{ name: 'api', path: '/elsewhere/api' }] }, repo: 'api' }),
    path.resolve('/elsewhere/api'),
  );
  assert.equal(resolveCheckout({ boardPath, config: CONFIG, repo: 'nope' }), null);
  assert.equal(resolveCheckout({ boardPath, config: null, repo: 'api' }), null);
});

test('start runs the generation against the checkout and records where it landed', async () => {
  const { dir, workspaceDir, boardPath } = await workspace(['api']);
  const seen = [];
  const runner = createRetroDocRunner({
    boardPath,
    config: CONFIG,
    completeFactory: async (args) => {
      seen.push(args);
      return async () => 'body';
    },
    run: async ({ repoRoot, generator, log }) => {
      log('digesting batch 1/1');
      return { outPath: path.join(repoRoot, 'docs/ai/retro-documentation.md'), markdown: `# ${generator}`, sources: [] };
    },
  });

  const started = runner.start({ repo: 'api', provider: 'copilot' });
  assert.equal(started.status, 202);
  assert.equal(started.job.status, 'running');
  assert.equal(started.job.generator, 'GitHub Copilot CLI');

  const finished = await runner.settled(started.job.id);
  assert.equal(finished.status, 'done');
  assert.equal(finished.out, path.join('docs', 'ai', 'retro-documentation.md'));
  assert.deepEqual(finished.log, ['digesting batch 1/1']);
  assert.equal(finished.error, null);
  assert.ok(finished.finishedAt);
  assert.deepEqual(seen, [{ provider: 'copilot', model: null }]);
  assert.deepEqual(runner.list().map((job) => job.id), [started.job.id]);
  assert.equal(runner.list('web').length, 0);
  assert.ok(seen.length === 1 && workspaceDir.includes('wk'));
  await rm(dir, { recursive: true, force: true });
});

test('a job that fails keeps the reason instead of disappearing', async () => {
  const { dir, boardPath } = await workspace(['api']);
  const runner = createRetroDocRunner({
    boardPath,
    config: CONFIG,
    completeFactory: async () => async () => '',
    run: async () => { throw new Error('`copilot` exited with code 1: not logged in'); },
  });
  const started = runner.start({ repo: 'api', provider: 'copilot' });
  const finished = await runner.settled(started.job.id);
  assert.equal(finished.status, 'error');
  assert.match(finished.error, /not logged in/);
  await rm(dir, { recursive: true, force: true });
});

test('start refuses a second run for the same repository while one is in flight', async () => {
  const { dir, boardPath } = await workspace(['api']);
  let release;
  const runner = createRetroDocRunner({
    boardPath,
    config: CONFIG,
    completeFactory: async () => async () => '',
    run: () => new Promise((resolve) => { release = () => resolve({ outPath: '/x/out.md', markdown: '', sources: [] }); }),
  });
  const first = runner.start({ repo: 'api' });
  const second = runner.start({ repo: 'api' });
  assert.equal(second.status, 409);
  assert.match(second.error, /already running/);
  assert.equal(second.job, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await runner.settled(first.job.id);
  assert.equal(runner.start({ repo: 'api' }).status, 202, 'the repo is free again once the run is over');
  await rm(dir, { recursive: true, force: true });
});

test('start rejects a repo it does not know, one that is not checked out, and an unknown provider', async () => {
  const { dir, boardPath } = await workspace(['api']);
  const runner = createRetroDocRunner({ boardPath, config: CONFIG, run: async () => assert.fail('nothing should run') });
  assert.deepEqual(runner.start({ repo: 'ghost' }), { status: 404, error: 'unknown repository: ghost' });
  assert.equal(runner.start({ repo: 'web' }).status, 404, 'web is in the config but not cloned');
  assert.match(runner.start({ repo: 'web' }).error, /not checked out at/);
  assert.deepEqual(runner.start({ repo: 'api', provider: 'gemini' }), { status: 400, error: 'unknown provider: gemini' });
  assert.deepEqual(runner.start({}), { status: 400, error: 'repo is required' });
  assert.deepEqual(runner.list(), []);
  await rm(dir, { recursive: true, force: true });
});

test('list returns the most recent job first', async () => {
  const { dir, boardPath } = await workspace(['api', 'web']);
  const runner = createRetroDocRunner({
    boardPath,
    config: CONFIG,
    completeFactory: async () => async () => '',
    run: async ({ repoRoot }) => ({ outPath: path.join(repoRoot, 'out.md'), markdown: '', sources: [] }),
  });
  const api = runner.start({ repo: 'api' });
  const web = runner.start({ repo: 'web' });
  await Promise.all([runner.settled(api.job.id), runner.settled(web.job.id)]);
  assert.deepEqual(runner.list().map((job) => job.repo), ['web', 'api']);
  await rm(dir, { recursive: true, force: true });
});
