import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/pipeline.js';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function fakeCloneFactory(state) {
  return async function fakeClone(url, dir) {
    await mkdir(dir, { recursive: true });
    state.cloned.push({ url, dir });
    return {
      dir,
      async checkoutBranch(branch) { state.branch = branch; },
      async hasChanges() { return state.hasChanges; },
      async commitAll(message) { state.commit = message; },
      async push(branch, opts) { state.pushed = branch; state.pushOpts = opts; },
      async createPR(title, body) { state.pr = { title, body }; },
    };
  };
}

const config = {
  defaultTargets: ['claude'],
  repos: [{ name: 'a', url: 'u', technologies: ['nestjs'], targets: ['claude'] }],
};

const skill = { name: 's', description: 'D', body: '# B', source: 'skills/nestjs/s/SKILL.md' };
const resolveSkills = async () => [skill];

test('dry-run renders files without cloning', async () => {
  const logs = [];
  const results = await run(config, {
    skillsDir: 'irrelevant',
    workDir: 'irrelevant',
    dryRun: true,
    resolveSkills,
    clone: () => { throw new Error('should not clone'); },
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.equal(results[0].status, 'dry-run');
  assert.ok(logs.some((l) => l.includes('.claude/skills/s/SKILL.md')));
});

test('full run writes files, commits, pushes, and skips PR when --pr absent', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(config, {
    skillsDir: 'irrelevant',
    workDir,
    pr: false,
    resolveSkills,
    clone: fakeCloneFactory(state),
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pushed');
  assert.equal(state.branch, 'maggie/update-skills');
  assert.equal(state.pushed, 'maggie/update-skills');
  assert.deepEqual(state.pushOpts, { force: true });
  assert.equal(state.pr, undefined);
  const written = await readFile(path.join(workDir, 'a', '.claude/skills/s/SKILL.md'), 'utf8');
  assert.match(written, /name: "s"/);
});

test('--pr opens a PR after push', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(config, {
    skillsDir: 'x', workDir, pr: true, resolveSkills,
    clone: fakeCloneFactory(state), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pr');
  assert.deepEqual(state.pr, { title: 'Sync AI agent skills', body: 'Automated skill sync from maggie.' });
});

test('no-op when nothing changed: no commit/push', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  const results = await run(config, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: fakeCloneFactory(state), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'skipped');
  assert.equal(state.commit, undefined);
  assert.equal(state.pushed, undefined);
});

test('errors are isolated per repo and recorded', async () => {
  const twoRepos = {
    defaultTargets: ['claude'],
    repos: [
      { name: 'bad', url: 'u', technologies: ['t'], targets: ['claude'] },
      { name: 'good', url: 'u', technologies: ['t'], targets: ['claude'] },
    ],
  };
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(twoRepos, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: async (url, dir) => {
      if (dir.endsWith('bad')) throw new Error('clone failed');
      return fakeCloneFactory(state)(url, dir);
    },
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /clone failed/);
  assert.equal(results[1].status, 'pushed');
});

test('warn callback from resolveSkills is forwarded to logger.warn', async () => {
  const warnings = [];
  const resolveSkillsWithWarn = async (_dir, _tech, { warn }) => {
    warn('missing technology xyz');
    return [skill];
  };
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  await run(config, {
    skillsDir: 'x', workDir, resolveSkills: resolveSkillsWithWarn,
    clone: fakeCloneFactory(state),
    logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.ok(warnings.some((w) => w.includes('missing technology xyz')));
});

test('warns when a repo resolves zero skills (non-strict)', async () => {
  const warnings = [];
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(config, {
    skillsDir: 'x', workDir, resolveSkills: async () => [],
    clone: fakeCloneFactory({ cloned: [], hasChanges: false }),
    logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.equal(results[0].status, 'skipped');
  assert.ok(warnings.some((w) => /a: no skills resolved for technologies \[nestjs\]/.test(w)));
});

test('strict mode turns a zero-skill repo into a recorded error, without cloning', async () => {
  const results = await run(config, {
    skillsDir: 'x', workDir: 'irrelevant', strict: true,
    resolveSkills: async () => [],
    clone: () => { throw new Error('should not clone'); },
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /no skills resolved/);
});

test('strict flag is forwarded to resolveSkills', async () => {
  let seenStrict;
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  await run(config, {
    skillsDir: 'x', workDir, strict: true,
    resolveSkills: async (_dir, _tech, opts) => { seenStrict = opts.strict; return [skill]; },
    clone: fakeCloneFactory({ cloned: [], hasChanges: false }),
    logger: silentLogger(),
  });
  assert.equal(seenStrict, true);
});

test('repoFilter restricts processing to one repo', async () => {
  const twoRepos = {
    defaultTargets: ['claude'],
    repos: [
      { name: 'a', url: 'u', technologies: ['t'], targets: ['claude'] },
      { name: 'b', url: 'u', technologies: ['t'], targets: ['claude'] },
    ],
  };
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(twoRepos, {
    skillsDir: 'x', workDir, repoFilter: 'b', resolveSkills,
    clone: fakeCloneFactory({ cloned: [], hasChanges: true }),
    logger: silentLogger(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].repo, 'b');
});

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

test('forwards a readManifest warning (e.g. corrupt manifest JSON) to the logger', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const clone = async (url, dir) => {
    await mkdir(path.join(dir, '.maggie'), { recursive: true });
    await writeFile(path.join(dir, '.maggie/manifest.json'), '{ not json');
    return fakeCloneFactory(state)(url, dir);
  };
  const warnings = [];
  const results = await run(config, {
    skillsDir: 'irrelevant', workDir, resolveSkills,
    clone, logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.equal(results[0].status, 'pushed');
  assert.ok(warnings.some((w) => /invalid JSON, treating as no manifest/.test(w)));
});
