import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, packagedSkillsDir, resolveSkillsDir } from '../src/main.js';

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
