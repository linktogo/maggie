import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lintMain } from '../src/lint.js';

const error = { severity: 'error', rule: 'secret', file: 'skills/a/b/SKILL.md', line: 3, message: 'm' };
const warning = { severity: 'warning', rule: 'insecure-url', file: 'skills/a/b/SKILL.md', line: 4, message: 'w' };

function capture() {
  const lines = [];
  return { lines, logger: { log: (m) => lines.push(m), warn() {}, error() {} } };
}

test('lintMain reports a clean library and exits 0', async () => {
  const { lines, logger } = capture();
  let dir;
  const code = await lintMain(['--skills', 'lib'], { lint: async (d) => { dir = d; return []; }, logger, cwd: '/ws' });
  assert.equal(code, 0);
  assert.equal(dir, path.resolve('/ws', 'lib'));
  assert.deepEqual(lines, [`✓ ${dir}: no findings`]);
});

test('lintMain exits 1 on errors, 0 on warnings alone, 1 on warnings with --strict', async () => {
  const { lines, logger } = capture();
  assert.equal(await lintMain(['--skills', 'lib'], { lint: async () => [warning, error], logger, cwd: '/ws' }), 1);
  assert.equal(lines[0], '✗ skills/a/b/SKILL.md:3 secret: m');
  assert.match(lines.at(-1), /^1 error\(s\), 1 warning\(s\) in /);
  assert.equal(await lintMain(['--skills', 'lib'], { lint: async () => [warning], logger, cwd: '/ws' }), 0);
  assert.equal(await lintMain(['--skills', 'lib', '--strict'], { lint: async () => [warning], logger, cwd: '/ws' }), 1);
});

test('lintMain --json prints a machine-readable report', async () => {
  const { lines, logger } = capture();
  await lintMain(['--skills', 'lib', '--json'], { lint: async () => [error], logger, cwd: '/ws' });
  const report = JSON.parse(lines[0]);
  assert.equal(report.errors, 1);
  assert.equal(report.warnings, 0);
  assert.deepEqual(report.findings, [error]);
});

test('lintMain runs the real linter on the repository library by default', async () => {
  const { logger } = capture();
  const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
  assert.equal(await lintMain([], { logger, cwd: repoRoot }), 0);
});
