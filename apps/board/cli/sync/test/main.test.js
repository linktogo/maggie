import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, packagedSkillsDir, resolveSkillsDir, syncStatus } from '../src/main.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

const fakeConfig = { defaultTargets: ['claude'], repos: [] };

test('main requires --config or --config-repo', async () => {
  await assert.rejects(
    () => main([], { loadConfig: async () => fakeConfig, runPipeline: async () => [], logger: silentLogger() }),
    /Missing required --config <path> or --config-repo/,
  );
});

test('main rejects passing both --config and --config-repo', async () => {
  await assert.rejects(
    () => main(['--config', 'repos.json', '--config-repo', 'https://x/c.git'], {
      loadConfig: async () => fakeConfig, runPipeline: async () => [], logger: silentLogger(),
    }),
    /Pass either --config or --config-repo, not both/,
  );
});

test('main loads config from a repo via --config-repo (with --config-file)', async () => {
  let repoArgs;
  const code = await main(['--config-repo', 'git@github.com:o/ai-config.git', '--config-file', 'sub/repos.json'], {
    loadConfigFromRepo: async (url, opts) => { repoArgs = { url, opts }; return fakeConfig; },
    runPipeline: async () => [{ status: 'pushed' }],
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.equal(repoArgs.url, 'git@github.com:o/ai-config.git');
  assert.equal(repoArgs.opts.configFile, 'sub/repos.json');
});

test('main passes parsed flags to the pipeline and returns 0 on success', async () => {
  let received;
  const code = await main(
    ['--config', 'repos.json', '--pr', '--repo', 'a', '--work-dir', '/tmp/x'],
    {
      loadConfig: async (p) => { assert.equal(p, 'repos.json'); return fakeConfig; },
      runPipeline: async (config, opts) => { received = opts; return [{ status: 'pushed' }]; },
      logger: silentLogger(),
    },
  );
  assert.equal(code, 0);
  assert.equal(received.pr, true);
  assert.equal(received.repoFilter, 'a');
  assert.equal(received.workDir, '/tmp/x');
  assert.equal(received.dryRun, false);
  assert.equal(received.strict, false);
});

test('main forwards --strict to the pipeline', async () => {
  let received;
  await main(['--config', 'repos.json', '--strict'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    logger: silentLogger(),
  });
  assert.equal(received.strict, true);
});

test('main defaults pr/dryRun to false and derives a workDir', async () => {
  let received;
  await main(['--config', 'repos.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    logger: silentLogger(),
  });
  assert.equal(received.pr, false);
  assert.equal(received.dryRun, false);
  assert.match(received.workDir, /maggie$/);
  assert.match(received.skillsDir, /skills$/);
});

test('resolveSkillsDir resolves an explicit value against the cwd', () => {
  assert.equal(
    resolveSkillsDir('custom/skills', { cwd: '/ws', exists: () => false }),
    path.resolve('/ws', 'custom/skills'),
  );
});

test('resolveSkillsDir prefers a skills/ folder in the cwd', () => {
  const checked = [];
  const dir = resolveSkillsDir(undefined, {
    cwd: '/ws',
    exists: (p) => { checked.push(p); return true; },
  });
  assert.equal(dir, path.join('/ws', 'skills'));
  assert.deepEqual(checked, [path.join('/ws', 'skills')]);
});

test('resolveSkillsDir falls back to the packaged skills library', () => {
  const dir = resolveSkillsDir(undefined, { cwd: '/ws', exists: () => false });
  assert.notEqual(dir, path.join('/ws', 'skills'));
  assert.equal(path.basename(dir), 'skills');
  assert.ok(path.isAbsolute(dir));
});

test('main forwards --skills to the pipeline', async () => {
  let received;
  await main(['--config', 'repos.json', '--skills', '/elsewhere/skills'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    logger: silentLogger(),
  });
  assert.equal(received.skillsDir, path.resolve('/elsewhere/skills'));
});

test('main returns 1 when any repo errored', async () => {
  const code = await main(['--config', 'repos.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async () => [{ status: 'pushed' }, { status: 'error', error: 'x' }],
    logger: silentLogger(),
  });
  assert.equal(code, 1);
});

test('packagedSkillsDir prefers the skills shipped inside the package, then the repository ones', () => {
  assert.equal(packagedSkillsDir(() => true, 'file:///pkg/cli/sync/src/main.js'), path.resolve('/pkg/skills'));
  assert.equal(
    packagedSkillsDir(() => false, 'file:///repo/apps/board/cli/sync/src/main.js'),
    path.resolve('/repo/skills'),
  );
});

test('main lints the library before syncing, unless --skip-lint', async () => {
  const fakeLint = async () => [];
  let received;
  const deps = {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    lint: fakeLint,
    logger: silentLogger(),
  };
  await main(['--config', 'repos.json'], deps);
  assert.equal(received.lint, fakeLint);
  await main(['--config', 'repos.json', '--skip-lint'], deps);
  assert.equal(received.lint, null);
});

test('main lints with the real linter by default', async () => {
  let received;
  await main(['--config', 'repos.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return []; },
    logger: silentLogger(),
  });
  assert.equal(typeof received.lint, 'function');
});

test('--check returns 1 on drift and 0 when every repo is in sync', async () => {
  let received;
  const deps = (results) => ({
    loadConfig: async () => fakeConfig,
    runPipeline: async (config, opts) => { received = opts; return results; },
    logger: silentLogger(),
  });
  assert.equal(await main(['--config', 'r.json', '--check'], deps([{ status: 'in-sync' }])), 0);
  assert.equal(received.check, true);
  assert.equal(await main(['--config', 'r.json', '--check'], deps([{ status: 'in-sync' }, { status: 'drift' }])), 1);
});

test('--check refuses --pr, --dry-run, and --out needs --check', async () => {
  const deps = { loadConfig: async () => fakeConfig, runPipeline: async () => [], logger: silentLogger() };
  await assert.rejects(() => main(['--config', 'r.json', '--check', '--pr'], deps), /cannot be combined with --pr or --dry-run/);
  await assert.rejects(() => main(['--config', 'r.json', '--check', '--dry-run'], deps), /cannot be combined/);
  await assert.rejects(() => main(['--config', 'r.json', '--out', 's.json'], deps), /pass --check too/);
});

test('--check --out writes the sync status for the board, resolved against the cwd', async () => {
  const writes = [];
  const logs = [];
  await main(['--config', 'r.json', '--check', '--out', 'wk/.maggie/sync-status.json'], {
    loadConfig: async () => fakeConfig,
    runPipeline: async () => [{ repo: 'a', status: 'in-sync', files: 2, drift: [] }],
    write: async (file, value) => writes.push([file, value]),
    now: () => new Date('2026-11-22T10:00:00Z'),
    cwd: '/ws',
    exists: () => true,
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.equal(writes[0][0], path.resolve('/ws', 'wk/.maggie/sync-status.json'));
  assert.equal(writes[0][1].repos.a.status, 'in-sync');
  assert.ok(logs.some((l) => l.startsWith('sync status written to')));
});

test('--out writes a real file by default, creating its directory', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-out-'));
  const out = path.join(dir, 'nested', 'status.json');
  await main(['--config', 'r.json', '--check', '--out', out], {
    loadConfig: async () => fakeConfig,
    runPipeline: async () => [{ repo: 'a', status: 'drift', files: 1, drift: [{ path: 'x', state: 'missing' }] }],
    logger: silentLogger(),
  });
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(written.repos.a.drift, [{ path: 'x', state: 'missing' }]);
});

test('syncStatus keys the results by repo, with defaults and errors', () => {
  const status = syncStatus([
    { repo: 'a', status: 'in-sync', files: 3, drift: [] },
    { repo: 'b', status: 'error', error: 'clone failed' },
  ], new Date('2026-11-22T10:00:00Z'));
  assert.deepEqual(status, {
    generatedAt: '2026-11-22T10:00:00.000Z',
    repos: {
      a: { status: 'in-sync', checkedAt: '2026-11-22T10:00:00.000Z', files: 3, drift: [] },
      b: { status: 'error', checkedAt: '2026-11-22T10:00:00.000Z', files: 0, drift: [], error: 'clone failed' },
    },
  });
  assert.match(syncStatus([]).generatedAt, /^\d{4}-/);
});
