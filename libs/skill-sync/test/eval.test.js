import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EVAL_AGENTS, evaluateSkill, formatReport, grade, loadEvals, parseEvalCase, runProcess,
} from '../src/eval.js';

const silent = { log() {} };
const skill = { name: 'modules', description: 'D', body: 'Put each feature in its own module.', source: 'skills/x/modules/SKILL.md', resources: [] };

const exists = async (file) => access(file).then(() => true, () => false);

// A fake agent that follows the skill when the skill is in the checkout.
function fakeAgent(calls = []) {
  return async ({ command, args, cwd, input }) => {
    calls.push({ command, args, input, hasSkill: await exists(path.join(cwd, '.claude/skills/modules/SKILL.md')) });
    const followed = calls.at(-1).hasSkill;
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(path.join(cwd, 'src', followed ? 'users.module.ts' : 'users.ts'), followed ? '@Module({})' : 'export {}');
    return { exitCode: 0, stdout: followed ? 'Created the users module' : 'Done', stderr: '', error: null };
  };
}

const evalCase = (overrides = {}) => ({
  name: 'users-feature',
  prompt: 'Add a users feature',
  fixture: null,
  assert: [{ type: 'file-contains', path: 'src/users.module.ts', pattern: '@Module' }],
  ...overrides,
});

// --- parsing ---

test('parseEvalCase accepts a full case and names it after the file when unnamed', () => {
  const parsed = parseEvalCase(JSON.stringify({
    prompt: 'p',
    fixture: 'starter',
    assert: [
      { type: 'file-exists', path: 'a' },
      { type: 'file-contains', path: 'a', pattern: 'x' },
      { type: 'file-not-contains', path: 'a', pattern: 'y' },
      { type: 'output-contains', pattern: 'z' },
      { type: 'command', run: 'true' },
    ],
  }), '/lib/evals/basic.json');
  assert.equal(parsed.name, 'basic');
  assert.equal(parsed.fixture, 'starter');
  assert.equal(parsed.assert.length, 5);
  assert.equal(parseEvalCase('{"name":"n","prompt":"p","assert":[{"type":"file-exists","path":"a"}]}', 'f.json').name, 'n');
});

test('parseEvalCase rejects malformed cases with the file and the reason', () => {
  const cases = [
    ['{', /f\.json: invalid JSON/],
    ['[]', /an eval case is a JSON object/],
    ['null', /an eval case is a JSON object/],
    ['{"assert":[]}', /"prompt" is required/],
    ['{"prompt":"  ","assert":[]}', /"prompt" is required/],
    ['{"prompt":"p","fixture":"../up","assert":[]}', /"fixture" must be a directory inside evals/],
    ['{"prompt":"p","fixture":"/abs","assert":[]}', /"fixture" must be/],
    ['{"prompt":"p","fixture":3,"assert":[]}', /"fixture" must be/],
    ['{"prompt":"p","assert":[]}', /"assert" must be a non-empty array/],
    ['{"prompt":"p"}', /"assert" must be a non-empty array/],
    ['{"prompt":"p","assert":[null]}', /assert\[0\]: unknown type undefined/],
    ['{"prompt":"p","assert":[{"type":"nope"}]}', /assert\[0\]: unknown type "nope"/],
    ['{"prompt":"p","assert":[{"type":"file-exists"}]}', /assert\[0\]: "path" is required/],
    ['{"prompt":"p","assert":[{"type":"output-contains"}]}', /"pattern" is required/],
    ['{"prompt":"p","assert":[{"type":"output-contains","pattern":"("}]}', /invalid pattern "\("/],
    ['{"prompt":"p","assert":[{"type":"command"}]}', /"run" is required/],
  ];
  for (const [raw, expected] of cases) assert.throws(() => parseEvalCase(raw, 'f.json'), expected, raw);
});

test('loadEvals reads evals/*.json in order and resolves fixtures; a skill without evals has none', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evals-'));
  assert.deepEqual(await loadEvals(dir), []);
  await mkdir(path.join(dir, 'evals', 'starter'), { recursive: true });
  await writeFile(path.join(dir, 'evals', 'b.json'), '{"prompt":"b","assert":[{"type":"output-contains","pattern":"x"}]}');
  await writeFile(path.join(dir, 'evals', 'a.json'), '{"prompt":"a","fixture":"starter","assert":[{"type":"output-contains","pattern":"x"}]}');
  await writeFile(path.join(dir, 'evals', 'notes.md'), 'ignored');
  const cases = await loadEvals(dir);
  assert.deepEqual(cases.map((c) => c.name), ['a', 'b']);
  assert.equal(cases[0].fixture, path.join(dir, 'evals', 'starter'));
  assert.equal(cases[1].fixture, null);
});

test('loadEvals rethrows when evals/ cannot be listed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evals-'));
  await writeFile(path.join(dir, 'evals'), 'a file, not a directory');
  await assert.rejects(() => loadEvals(dir), (err) => err.code === 'ENOTDIR');
});

// --- grading ---

test('grade checks files, output and commands', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'grade-'));
  await writeFile(path.join(cwd, 'a.ts'), 'export const a = 1;');
  const commands = [];
  const runCommand = async (opts) => { commands.push(opts); return { exitCode: opts.command === 'ok' ? 0 : 2, error: null }; };
  const failures = await grade([
    { type: 'file-exists', path: 'a.ts' },
    { type: 'file-exists', path: 'missing.ts' },
    { type: 'file-contains', path: 'a.ts', pattern: 'const a' },
    { type: 'file-contains', path: 'a.ts', pattern: 'const b' },
    { type: 'file-contains', path: 'missing.ts', pattern: 'x' },
    { type: 'file-not-contains', path: 'a.ts', pattern: 'any' },
    { type: 'file-not-contains', path: 'a.ts', pattern: 'export' },
    { type: 'file-not-contains', path: 'missing.ts', pattern: 'x' },
    { type: 'output-contains', pattern: 'done' },
    { type: 'output-contains', pattern: 'nope' },
    { type: 'command', run: 'ok' },
    { type: 'command', run: 'fail' },
  ], { cwd, output: 'all done', runCommand, timeoutMs: 1000 });
  assert.deepEqual(failures, [
    'file-exists missing.ts',
    'file-contains a.ts const b',
    'file-contains missing.ts x',
    'file-not-contains a.ts export',
    'output-contains nope',
    'command `fail` exited with 2',
  ]);
  assert.deepEqual(commands.map((c) => [c.command, c.cwd, c.shell]), [['ok', cwd, true], ['fail', cwd, true]]);
});

test('grade reports a command that could not run with its error', async () => {
  const failures = await grade([{ type: 'command', run: 'x' }], {
    cwd: tmpdir(), output: '', timeoutMs: 1, runCommand: async () => ({ exitCode: null, error: 'timed out after 0s' }),
  });
  assert.deepEqual(failures, ['command `x` exited with timed out after 0s']);
});

// --- running ---

test('evaluateSkill runs each case without then with the skill, and measures the difference', async () => {
  const calls = [];
  const logs = [];
  const report = await evaluateSkill(skill, [evalCase()], {
    runAgent: fakeAgent(calls), runs: 2, logger: { log: (m) => logs.push(m) },
  });
  assert.deepEqual(calls.map((c) => c.hasSkill), [false, true, false, true]);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, EVAL_AGENTS['claude-cli'].args);
  assert.equal(calls[0].input, 'Add a users feature');
  assert.equal(report.cases[0].baselineRate, 0);
  assert.equal(report.cases[0].skillRate, 1);
  assert.equal(report.delta, 1);
  assert.equal(report.agentErrors, 0);
  assert.equal(report.cases[0].baseline[0].agentError, undefined);
  assert.equal(report.cases[0].baseline[0].failures[0], 'file-contains src/users.module.ts @Module');
  assert.ok(logs.includes('✓ modules › users-feature [skill #2]'));
  assert.ok(logs.some((l) => l.startsWith('✗ modules › users-feature [baseline #1]: file-contains')));
});

test('evaluateSkill copies the fixture, renders for the chosen agent, passes the model, and cleans up', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'fixture-'));
  await writeFile(path.join(fixture, 'package.json'), '{}');
  const workDir = await mkdtemp(path.join(tmpdir(), 'evalwd-'));
  const seen = [];
  await evaluateSkill({ ...skill, resources: [{ path: 'scripts/x.sh', content: Buffer.from('x') }] }, [evalCase({ fixture })], {
    agent: 'copilot', model: 'gpt-x', workDir, logger: silent,
    runAgent: async ({ command, args, cwd }) => {
      seen.push({
        command, args,
        fixture: await exists(path.join(cwd, 'package.json')),
        rule: await exists(path.join(cwd, '.github/instructions/modules.instructions.md')),
        resource: await exists(path.join(cwd, '.maggie/skills/modules/scripts/x.sh')),
      });
      return { exitCode: 0, stdout: '', error: null };
    },
  });
  assert.deepEqual(seen.map((s) => [s.fixture, s.rule, s.resource]), [[true, false, false], [true, true, true]]);
  assert.equal(seen[0].command, 'copilot');
  assert.deepEqual(seen[0].args, ['--allow-all-tools', '--model', 'gpt-x']);
  assert.deepEqual(await readdir(workDir), []);
});

test('evaluateSkill keeps the checkouts with keep', async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'evalwd-'));
  await evaluateSkill(skill, [evalCase()], { workDir, keep: true, runAgent: fakeAgent(), logger: silent });
  assert.equal((await readdir(workDir)).length, 1);
});

test('an agent that fails to run fails the run, without grading', async () => {
  const report = await evaluateSkill(skill, [evalCase({ assert: [{ type: 'command', run: 'never' }] })], {
    logger: silent,
    runAgent: async () => ({ exitCode: null, stdout: '', error: 'spawn claude ENOENT' }),
    runCommand: () => { throw new Error('should not grade'); },
  });
  assert.deepEqual(report.cases[0].skill[0].failures, ['agent failed: spawn claude ENOENT']);
  assert.equal(report.cases[0].skill[0].agentError, 'spawn claude ENOENT');
  assert.equal(report.agentErrors, 2);
  assert.match(formatReport(report).at(-1), /⚠ 2 run\(s\) did not complete/);
});

test('evaluateSkill refuses an unknown agent', async () => {
  await assert.rejects(() => evaluateSkill(skill, [], { agent: 'nope' }), /unknown eval agent: nope/);
});

test('a skill without cases scores zero both ways', async () => {
  const report = await evaluateSkill(skill, [], { logger: silent });
  assert.deepEqual([report.baselineRate, report.skillRate, report.delta], [0, 0, 0]);
});

// --- report ---

test('formatReport gives a verdict on the delta', () => {
  const base = { skill: 's', agent: 'claude-cli', model: null, runs: 1 };
  const helps = formatReport({ ...base, cases: [{ name: 'c', baselineRate: 0, skillRate: 1, delta: 1 }], baselineRate: 0, skillRate: 1, delta: 1 });
  assert.deepEqual(helps, ['s (claude-cli, 1 run(s) per case):', '  c: 0% → 100% (+100 pts)', '  overall: 0% without the skill → 100% with it: helps']);
  const worse = formatReport({ ...base, model: 'm', cases: [{ name: 'c', baselineRate: 1, skillRate: 0.5, delta: -0.5 }], baselineRate: 1, skillRate: 0.5, delta: -0.5 });
  assert.equal(worse[0], 's (claude-cli, m, 1 run(s) per case):');
  assert.equal(worse[1], '  c: 100% → 50% (-50 pts)');
  assert.match(worse[2], /makes things worse$/);
  const none = formatReport({ ...base, cases: [], baselineRate: 1, skillRate: 1, delta: 0 });
  assert.match(none.at(-1), /changes nothing measured by its evals/);
});

// --- runProcess (real processes) ---

test('runProcess feeds stdin and collects stdout, stderr and the exit code', async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase())); process.stderr.write("warn"); process.stdin.on("end", () => process.exit(3))'],
    cwd: tmpdir(), input: 'hello', timeoutMs: 10000,
  });
  assert.deepEqual(result, { exitCode: 3, stdout: 'HELLO', stderr: 'warn', error: null });
});

test('runProcess runs shell commands in the given directory', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'proc-'));
  const result = await runProcess({ command: 'echo hi > out.txt', args: [], cwd, shell: true, timeoutMs: 10000 });
  assert.equal(result.exitCode, 0);
  assert.ok(await exists(path.join(cwd, 'out.txt')));
});

test('runProcess kills a process that runs past the timeout', async () => {
  const result = await runProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: tmpdir(), timeoutMs: 200 });
  assert.equal(result.exitCode, null);
  assert.equal(result.error, 'timed out after 0s');
});

test('runProcess reports a command that does not exist', async () => {
  const result = await runProcess({ command: 'maggie-no-such-agent-cli', args: [], cwd: tmpdir(), timeoutMs: 10000 });
  assert.equal(result.exitCode, null);
  assert.match(result.error, /ENOENT/);
});

test('runProcess reports a spawn that throws', async () => {
  const result = await runProcess({ command: 'x', args: [], cwd: tmpdir(), timeoutMs: 10, spawn: () => { throw new Error('bad args'); } });
  assert.deepEqual(result, { exitCode: null, stdout: '', stderr: '', error: 'bad args' });
});

test('runProcess survives an agent that exits without reading its prompt', async () => {
  const result = await runProcess({
    command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: tmpdir(), input: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 0);
});
