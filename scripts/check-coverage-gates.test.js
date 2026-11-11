import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkNodeTestCommand, checkVitestConfig, collectTestCommands, checkProject, listProjectDirs, checkWorkspace,
} from './check-coverage-gates.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATED = 'node --test --experimental-test-coverage --test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100 "x/**/*.test.js"';
const FULL_VITEST = { coverage: { enabled: true, thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 } } };

test('a node:test command with coverage and all three thresholds at 100 passes', () => {
  assert.deepEqual(checkNodeTestCommand(GATED), []);
});

test('a node:test command without coverage is refused outright', () => {
  assert.equal(checkNodeTestCommand('node --test "x/*.test.js"').length, 1);
  assert.match(checkNodeTestCommand('node --test "x/*.test.js"')[0], /without --experimental-test-coverage/);
});

test('each missing or lowered node:test threshold is reported', () => {
  const lowered = GATED.replace('--test-coverage-branches=100', '--test-coverage-branches=90');
  assert.deepEqual(checkNodeTestCommand(lowered).length, 1);
  assert.match(checkNodeTestCommand(lowered)[0], /branches=100/);
  // 1000 is not 100: the threshold must be exactly 100.
  assert.equal(checkNodeTestCommand(GATED.replace('lines=100', 'lines=1000')).length, 1);
  assert.equal(checkNodeTestCommand('node --test --experimental-test-coverage x').length, 3);
});

test('a vitest config needs coverage enabled and every threshold at 100', () => {
  assert.deepEqual(checkVitestConfig(FULL_VITEST), []);
  assert.deepEqual(checkVitestConfig({ coverage: { enabled: true, thresholds: { 100: true } } }), []);
  assert.equal(checkVitestConfig({}).length, 5);
  assert.deepEqual(
    checkVitestConfig({ coverage: { enabled: true, thresholds: { ...FULL_VITEST.coverage.thresholds, statements: 99 } } }),
    ['vitest test.coverage.thresholds.statements is not 100'],
  );
  assert.match(checkVitestConfig({ coverage: { thresholds: { 100: true } } })[0], /not enabled/);
});

test('collectTestCommands follows dependsOn within the project, once each, ignoring ^ targets', () => {
  const targets = {
    test: { dependsOn: ['^build', 'unit', { target: 'e2e' }, 'unit', 'missing'], options: { command: 'a' } },
    unit: { options: { commands: ['b', { command: 'c' }] }, dependsOn: ['test'] },
    e2e: {},
  };
  assert.deepEqual(collectTestCommands(targets), ['a', 'b', 'c']);
});

test('checkProject passes a gated node:test project and a gated vitest project', () => {
  assert.deepEqual(checkProject({ name: 'lib', targets: { test: { options: { command: GATED } } }, vitest: null }), []);
  assert.deepEqual(checkProject({ name: 'web', targets: { test: { dependsOn: ['srv'] }, srv: { options: { command: GATED } } }, vitest: FULL_VITEST }), []);
});

test('checkProject reports a project with no test target, or one that gates nothing', () => {
  assert.deepEqual(checkProject({ name: 'lib', targets: {}, vitest: null }), ['lib: no "test" target']);
  assert.deepEqual(
    checkProject({ name: 'lib', targets: { test: { options: { command: 'echo ok' } } }, vitest: null }),
    ['lib: the "test" target runs no coverage-gated test runner'],
  );
});

test('checkProject reports an ungated node:test command, a vitest gap and a vitest run with no config', () => {
  const problems = checkProject({
    name: 'web',
    targets: { test: { dependsOn: ['srv', 'ui'] }, srv: { options: { command: 'node --test x' } }, ui: { options: { command: 'vitest run' } } },
    vitest: null,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^web: `node --test x` runs node:test without/);
  assert.match(problems[1], /runs vitest without a vite config/);
  assert.equal(checkProject({ name: 'web', targets: { test: {} }, vitest: {} }).length, 5);
});

async function workspace(projects) {
  const root = await mkdtemp(path.join(tmpdir(), 'coverage-gates-'));
  for (const [rel, files] of Object.entries(projects)) {
    await mkdir(path.join(root, rel), { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      await writeFile(path.join(root, rel, file), typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
  return root;
}

test('checkWorkspace reads project.json, package.json nx targets and vite configs under apps/, libs/ and .github/actions/', async () => {
  const root = await workspace({
    'libs/core': { 'project.json': { name: 'core', targets: { test: { options: { command: GATED } } } } },
    'libs/bare': { 'project.json': { name: 'bare' } },
    'apps/web': {
      'package.json': { name: '@x/web', nx: { targets: { test: {} } } },
      'vite.config.mjs': `export default { test: ${JSON.stringify({ coverage: { enabled: true, thresholds: { 100: true } } })} };`,
    },
    'apps/named': { 'package.json': { name: '@x/named', nx: { name: 'renamed', targets: { test: { options: { command: 'node --test x' } } } } } },
    'apps/plain': { 'package.json': { name: '@x/plain' }, 'vite.config.js': 'export default {};' },
    'apps/notes': { 'README.md': '# not a project' },
    '.github/actions/report': { 'project.json': { name: 'report', targets: { test: { options: { command: GATED } } } } },
  });
  await writeFile(path.join(root, 'apps', 'file.txt'), 'not a directory');
  const { projects, problems } = await checkWorkspace(root);
  assert.deepEqual(projects, ['report', 'renamed', '@x/plain', '@x/web', 'bare', 'core']);
  assert.deepEqual(problems, [
    'renamed: `node --test x` runs node:test without --experimental-test-coverage',
    '@x/plain: no "test" target',
    'bare: no "test" target',
  ]);
  await rm(root, { recursive: true, force: true });
});

test('listProjectDirs tolerates a workspace without apps/ or libs/', async () => {
  const root = await workspace({ 'libs/core': { 'project.json': { name: 'core' } } });
  assert.deepEqual(listProjectDirs(root), [path.join(root, 'libs', 'core')]);
  await rm(root, { recursive: true, force: true });
});

test('this repository enforces the gate in every project', async () => {
  const { projects, problems } = await checkWorkspace();
  assert.deepEqual(problems, []);
  assert.ok(projects.includes('board'));
  assert.ok(projects.includes('ci-status-report'));
});

async function cliRepo(projects) {
  const root = await workspace(projects);
  await mkdir(path.join(root, 'scripts'));
  await copyFile(path.join(SCRIPT_DIR, 'check-coverage-gates.js'), path.join(root, 'scripts', 'check-coverage-gates.js'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  return root;
}

function runCli(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(root, 'scripts', 'check-coverage-gates.js')], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status, out: err.stderr };
  }
}

test('the CLI lists the gated projects and exits 0', async () => {
  const root = await cliRepo({ 'libs/core': { 'project.json': { name: 'core', targets: { test: { options: { command: GATED } } } } } });
  const { code, out } = runCli(root);
  assert.equal(code, 0);
  assert.match(out, /100% coverage gate enforced in 1 project\(s\): core/);
  await rm(root, { recursive: true, force: true });
});

test('the CLI lists every problem and exits 1', async () => {
  const root = await cliRepo({ 'libs/core': { 'project.json': { name: 'core', targets: { test: { options: { command: 'node --test x' } } } } } });
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.match(out, /✗ core: `node --test x` runs node:test without/);
  await rm(root, { recursive: true, force: true });
});

test('the CLI reports an unreadable project file as an error and exits 1', async () => {
  const root = await cliRepo({ 'libs/core': { 'project.json': '{not json' } });
  const { code, out } = runCli(root);
  assert.equal(code, 1);
  assert.match(out, /^Error: /);
  await rm(root, { recursive: true, force: true });
});
