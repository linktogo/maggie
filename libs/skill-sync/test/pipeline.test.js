import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/pipeline.js';
import { renderRepo } from '@linktogo/maggie-renderers';

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
      JSON.stringify({ version: 1, paths: ['.claude/skills/s/SKILL.md', '.claude/skills/stale-skill/SKILL.md'], blocks: [] }),
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
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/s/SKILL.md'], blocks: [] });
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
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/s/SKILL.md'], blocks: [] });
});

test('skips pruning and leaves the manifest untouched when the new render is empty but the old manifest was not', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  const clone = async (url, dir) => {
    await mkdir(path.join(dir, '.maggie'), { recursive: true });
    await writeFile(
      path.join(dir, '.maggie/manifest.json'),
      JSON.stringify({ version: 1, paths: ['.claude/skills/old-skill/SKILL.md'], blocks: [] }),
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
  assert.deepEqual(manifest, { version: 1, paths: ['.claude/skills/old-skill/SKILL.md'], blocks: [] });
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

// --- managed blocks (AGENTS.md) ---

const agentsConfig = {
  defaultTargets: ['agents'],
  repos: [{ name: 'a', url: 'u', technologies: ['nestjs'], targets: ['agents'] }],
};

function cloneWith(state, files) {
  return async (url, dir, opts) => {
    state.cloneOpts = opts;
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), content);
    }
    return fakeCloneFactory(state)(url, dir);
  };
}

test('the agents target merges its index into AGENTS.md, keeping the hand-written part', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  await run(agentsConfig, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: cloneWith(state, { 'AGENTS.md': '# Team rules\n\nUse pnpm.\n' }), logger: silentLogger(),
  });
  const agentsMd = await readFile(path.join(workDir, 'a', 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /^# Team rules\n\nUse pnpm\.\n\n<!-- maggie:begin skills/);
  assert.match(agentsMd, /\| \[`s`\]\(\.agents\/skills\/s\/SKILL\.md\) \| D \|/);
  const manifest = JSON.parse(await readFile(path.join(workDir, 'a', '.maggie/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { version: 1, paths: ['.agents/skills/s/SKILL.md'], blocks: [{ path: 'AGENTS.md', id: 'skills' }] });
});

test('a block the render no longer owns is removed, keeping the rest of the file', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const logs = [];
  await run(config, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: cloneWith(state, {
      'AGENTS.md': '# Team\n\n<!-- maggie:begin skills — x -->\nold\n<!-- maggie:end skills -->\n',
      '.maggie/manifest.json': JSON.stringify({ version: 1, paths: [], blocks: [{ path: 'AGENTS.md', id: 'skills' }] }),
    }),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.equal(await readFile(path.join(workDir, 'a', 'AGENTS.md'), 'utf8'), '# Team\n');
  assert.ok(logs.some((l) => l.includes('pruning the skills block of AGENTS.md')));
});

test('a file left empty by removing its block is deleted; a block whose file is gone is skipped', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  await run(config, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: cloneWith(state, {
      'AGENTS.md': '<!-- maggie:begin skills — x -->\nold\n<!-- maggie:end skills -->\n',
      '.maggie/manifest.json': JSON.stringify({
        version: 1, paths: [], blocks: [{ path: 'AGENTS.md', id: 'skills' }, { path: 'GONE.md', id: 'skills' }],
      }),
    }),
    logger: silentLogger(),
  });
  await assert.rejects(() => readFile(path.join(workDir, 'a', 'AGENTS.md')), (err) => err.code === 'ENOENT');
});

test('an empty render leaves tracked blocks alone too', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: false };
  const warnings = [];
  await run(config, {
    skillsDir: 'x', workDir, resolveSkills: async () => [],
    clone: cloneWith(state, {
      '.maggie/manifest.json': JSON.stringify({ version: 1, paths: [], blocks: [{ path: 'AGENTS.md', id: 'skills' }] }),
    }),
    logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.ok(warnings.some((w) => /new render is empty but 1 file\(s\)/.test(w)));
});

test('dry-run labels managed blocks', async () => {
  const logs = [];
  await run(agentsConfig, {
    skillsDir: 'x', workDir: 'x', dryRun: true, resolveSkills,
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.ok(logs.includes('[dry-run] a: AGENTS.md (skills block)'));
});

test('reading a checkout file fails loudly on anything but a missing file', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const results = await run(agentsConfig, {
    skillsDir: 'x', workDir, resolveSkills,
    clone: cloneWith(state, { 'AGENTS.md/inner': 'AGENTS.md is a directory' }), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /EISDIR/);
});

// --- lint gate ---

test('a lint error in the library stops the run before any repository is touched', async () => {
  const errors = [];
  let lintedDir;
  const results = await run(config, {
    skillsDir: 'lib', workDir: 'x', resolveSkills,
    lint: async (dir) => {
      lintedDir = dir;
      return [
        { severity: 'error', file: 'skills/x/s/SKILL.md', line: 3, rule: 'secret', message: 'AWS key' },
        { severity: 'warning', file: 'skills/x/s/SKILL.md', line: 4, rule: 'insecure-url', message: 'http' },
      ];
    },
    clone: () => { throw new Error('should not clone'); },
    logger: { log() {}, warn() {}, error: (m) => errors.push(m) },
  });
  assert.equal(lintedDir, 'lib');
  assert.deepEqual(results, [{ repo: 'a', status: 'error', error: 'the skills library has 1 lint error(s); run `maggie lint`' }]);
  assert.ok(errors.includes('✗ skills/x/s/SKILL.md:3 secret: AWS key'));
  assert.ok(!errors.some((e) => e.includes('insecure-url')));
});

test('lint warnings alone do not stop the run', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(config, {
    skillsDir: 'x', workDir, resolveSkills,
    lint: async () => [{ severity: 'warning', file: 'f', line: 1, rule: 'r', message: 'm' }],
    clone: fakeCloneFactory({ cloned: [], hasChanges: true }), logger: silentLogger(),
  });
  assert.equal(results[0].status, 'pushed');
});

// --- check (drift detection) ---

async function renderedFiles(targets) {
  return Object.fromEntries(renderRepo(targets, [skill]).map((f) => [f.path, f]));
}

test('check reports a repository whose default branch matches the render as in sync, without pushing', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const files = await renderedFiles(['agents']);
  const state = { cloned: [], hasChanges: true };
  const results = await run(agentsConfig, {
    skillsDir: 'x', workDir, check: true, resolveSkills,
    clone: cloneWith(state, {
      '.agents/skills/s/SKILL.md': files['.agents/skills/s/SKILL.md'].content,
      'AGENTS.md': `# Mine\n\n<!-- maggie:begin skills — x -->\n${files['AGENTS.md'].content}\n<!-- maggie:end skills -->\n`,
    }),
    logger: silentLogger(),
  });
  assert.deepEqual(results, [{ repo: 'a', status: 'in-sync', files: 2, drift: [] }]);
  assert.deepEqual(state.cloneOpts, { depth: 1 });
  assert.equal(state.branch, undefined);
  assert.equal(state.pushed, undefined);
});

test('check lists missing, modified and stale files and blocks', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const state = { cloned: [], hasChanges: true };
  const logs = [];
  const results = await run(agentsConfig, {
    skillsDir: 'x', workDir, check: true, resolveSkills,
    clone: cloneWith(state, {
      '.agents/skills/s/SKILL.md': 'hand-edited',
      '.claude/skills/old/SKILL.md': 'left behind',
      'NOTES.md': '<!-- maggie:begin notes — x -->\nold\n<!-- maggie:end notes -->\n',
      '.maggie/manifest.json': JSON.stringify({
        version: 1,
        paths: ['.claude/skills/old/SKILL.md', '.claude/skills/already-gone/SKILL.md'],
        blocks: [{ path: 'NOTES.md', id: 'notes' }, { path: 'GONE.md', id: 'notes' }],
      }),
    }),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.equal(results[0].status, 'drift');
  assert.deepEqual(results[0].drift, [
    { path: '.agents/skills/s/SKILL.md', state: 'modified' },
    { path: 'AGENTS.md', block: 'skills', state: 'missing' },
    { path: '.claude/skills/old/SKILL.md', state: 'stale' },
    { path: 'NOTES.md', block: 'notes', state: 'stale' },
  ]);
  assert.ok(logs.includes('≠ a: 4 file(s) out of sync'));
  assert.ok(logs.includes('    missing  AGENTS.md (skills block)'));
  assert.ok(logs.includes('    modified .agents/skills/s/SKILL.md'));
});

test('check reports a missing file and a modified block', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(agentsConfig, {
    skillsDir: 'x', workDir, check: true, resolveSkills,
    clone: cloneWith({ cloned: [] }, {
      'AGENTS.md': '<!-- maggie:begin skills — x -->\nhand-edited\n<!-- maggie:end skills -->\n',
    }),
    logger: silentLogger(),
  });
  assert.deepEqual(results[0].drift, [
    { path: '.agents/skills/s/SKILL.md', state: 'missing' },
    { path: 'AGENTS.md', block: 'skills', state: 'modified' },
  ]);
});

test('check fails loudly when a rendered path cannot be read', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const results = await run(config, {
    skillsDir: 'x', workDir, check: true, resolveSkills,
    clone: cloneWith({ cloned: [] }, { '.claude/skills/s/SKILL.md/inner': 'a directory' }),
    logger: silentLogger(),
  });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /EISDIR/);
});

test('check forwards manifest warnings to the logger', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'pipe-'));
  const warnings = [];
  await run(config, {
    skillsDir: 'x', workDir, check: true, resolveSkills,
    clone: cloneWith({ cloned: [] }, { '.maggie/manifest.json': '{ nope' }),
    logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.ok(warnings.some((w) => /invalid JSON/.test(w)));
});
