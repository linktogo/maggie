import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { evalMain } from '../src/eval.js';

const skills = [
  { name: 'with-evals', dir: '/lib/a/with-evals' },
  { name: 'no-evals', dir: '/lib/a/no-evals' },
];
const report = (delta) => ({ skill: 'with-evals', agent: 'claude-cli', model: null, runs: 1, cases: [], baselineRate: 0, skillRate: delta, delta });

function deps(overrides = {}) {
  const lines = [];
  const calls = [];
  return {
    lines,
    calls,
    deps: {
      resolveSkills: async () => skills,
      listTechnologies: async () => ['a'],
      loadEvals: async (dir) => (dir.endsWith('with-evals') ? [{ name: 'c' }] : []),
      evaluateSkill: async (skill, cases, opts) => { calls.push({ skill, cases, opts }); return report(0.5); },
      logger: { log: (m) => lines.push(m) },
      cwd: '/ws',
      exists: () => true,
      ...overrides,
    },
  };
}

test('evalMain evaluates every skill that has evals and prints the report', async () => {
  const { lines, calls, deps: d } = deps();
  assert.equal(await evalMain([], d), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skill.name, 'with-evals');
  assert.deepEqual(calls[0].opts, {
    agent: 'claude-cli', model: null, runs: 1, timeoutMs: 600000, workDir: os.tmpdir(), keep: false, logger: d.logger,
  });
  assert.match(lines.at(-1), /overall: 0% without the skill → 50% with it: helps/);
});

test('evalMain passes the agent options through', async () => {
  const { calls, deps: d } = deps();
  await evalMain(['--agent', 'copilot', '--model', 'm', '--runs', '3', '--timeout', '30', '--work-dir', 'tmp/evals', '--keep'], d);
  assert.deepEqual({ ...calls[0].opts, logger: undefined }, {
    agent: 'copilot', model: 'm', runs: 3, timeoutMs: 30000, workDir: path.resolve('/ws', 'tmp/evals'), keep: true, logger: undefined,
  });
});

test('evalMain --skill selects skills, and says when one has no evals', async () => {
  const { lines, calls, deps: d } = deps();
  await evalMain(['--skill', 'no-evals'], d);
  assert.equal(calls.length, 0);
  assert.match(lines[0], /^- no-evals: no evals \(add .*evals\/<case>\.json\)$/);
  assert.match(lines.at(-1), /^no skill with evals in /);
});

test('evalMain refuses an unknown skill and bad numbers', async () => {
  const { deps: d } = deps();
  await assert.rejects(() => evalMain(['--skill', 'nope'], d), /no such skill in .*: nope/);
  await assert.rejects(() => evalMain(['--runs', '0'], d), /--runs must be a positive integer, got 0/);
  await assert.rejects(() => evalMain(['--timeout', 'x'], d), /--timeout must be a positive integer/);
});

test('evalMain --json prints the reports and keeps the per-run lines quiet', async () => {
  const { lines, calls, deps: d } = deps();
  await evalMain(['--json'], d);
  calls[0].opts.logger.log('ignored');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).reports[0].delta, 0.5);
});

test('--fail-on-regression exits 1 when a skill makes things worse', async () => {
  const { deps: d } = deps({ evaluateSkill: async () => report(-0.5) });
  assert.equal(await evalMain([], d), 0);
  assert.equal(await evalMain(['--fail-on-regression'], d), 1);
  const { deps: ok } = deps();
  assert.equal(await evalMain(['--fail-on-regression'], ok), 0);
});

test('evalMain lists the library technologies by default, skipping files and dotfiles', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'evallib-'));
  await mkdir(path.join(dir, 'b'));
  await mkdir(path.join(dir, 'a'));
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, 'README.md'), '');
  let technos;
  const { deps: d } = deps({ listTechnologies: undefined, resolveSkills: async (_dir, t) => { technos = t; return []; } });
  delete d.listTechnologies;
  await evalMain(['--skills', dir], d);
  assert.deepEqual(technos, ['a', 'b']);
});

test('evalMain silences resolver warnings and resolves --work-dir against the process cwd by default', async () => {
  const { calls, deps: d } = deps({ resolveSkills: async (_dir, _t, { warn }) => { warn('collision'); return skills; } });
  delete d.cwd;
  await evalMain(['--skills', '/lib', '--work-dir', 'evals-tmp'], d);
  assert.equal(calls[0].opts.workDir, path.resolve(process.cwd(), 'evals-tmp'));
});
