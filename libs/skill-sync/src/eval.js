import { spawn as nodeSpawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderRepo as defaultRenderRepo } from '@linktogo/maggie-renderers';

// Skill evals: does a skill change what the agent does? Each case of a skill's
// `evals/*.json` is run twice from the same starting checkout, once without the skill
// (the baseline) and once with it rendered for the agent, and graded by the same
// assertions. The difference between the two pass rates is what the skill is worth;
// a skill that changes nothing only costs context.
//
// A case is { name, prompt, fixture?, assert: [...] }. `fixture` is a directory, relative
// to evals/, copied as the starting checkout (an empty directory otherwise). Assertions:
//   { type: 'file-exists', path }            { type: 'file-contains', path, pattern }
//   { type: 'file-not-contains', path, pattern }  { type: 'output-contains', pattern }
//   { type: 'command', run }   (a shell command run in the checkout, must exit 0)
// Patterns are regular expressions. Evals run real agents and the commands they name:
// they belong to the reviewed skills library, like the skills themselves.

export const EVAL_AGENTS = {
  'claude-cli': { target: 'claude', command: 'claude', args: ['-p', '--permission-mode', 'acceptEdits'] },
  copilot: { target: 'copilot', command: 'copilot', args: ['--allow-all-tools'] },
};

const ASSERTIONS = new Set(['file-exists', 'file-contains', 'file-not-contains', 'output-contains', 'command']);
export const DEFAULT_EVAL_TIMEOUT_MS = 10 * 60 * 1000;

function invalid(file, message) {
  return new Error(`${file}: ${message}`);
}

function checkPattern(file, pattern) {
  try {
    new RegExp(pattern);
  } catch (err) {
    throw invalid(file, `invalid pattern ${JSON.stringify(pattern)}: ${err.message}`);
  }
}

/** Parse and validate one eval file. */
export function parseEvalCase(raw, file) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw invalid(file, `invalid JSON (${err.message})`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw invalid(file, 'an eval case is a JSON object');
  if (typeof data.prompt !== 'string' || data.prompt.trim() === '') throw invalid(file, '"prompt" is required');
  if (data.fixture !== undefined && (typeof data.fixture !== 'string' || data.fixture.startsWith('/') || data.fixture.split(/[\\/]/).includes('..'))) {
    throw invalid(file, '"fixture" must be a directory inside evals/');
  }
  if (!Array.isArray(data.assert) || data.assert.length === 0) throw invalid(file, '"assert" must be a non-empty array');
  data.assert.forEach((assertion, i) => {
    if (!assertion || !ASSERTIONS.has(assertion.type)) throw invalid(file, `assert[${i}]: unknown type ${JSON.stringify(assertion?.type)}`);
    if (assertion.type.startsWith('file-') && typeof assertion.path !== 'string') throw invalid(file, `assert[${i}]: "path" is required`);
    if (['file-contains', 'file-not-contains', 'output-contains'].includes(assertion.type)) {
      if (typeof assertion.pattern !== 'string') throw invalid(file, `assert[${i}]: "pattern" is required`);
      checkPattern(file, assertion.pattern);
    }
    if (assertion.type === 'command' && typeof assertion.run !== 'string') throw invalid(file, `assert[${i}]: "run" is required`);
  });
  return {
    name: typeof data.name === 'string' && data.name ? data.name : path.basename(file, '.json'),
    prompt: data.prompt,
    fixture: data.fixture ?? null,
    assert: data.assert,
  };
}

/** The eval cases of a skill (its `evals/*.json`, sorted), with their fixture resolved. */
export async function loadEvals(skillDir) {
  const dir = path.join(skillDir, 'evals');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const cases = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(dir, entry);
    const evalCase = parseEvalCase(await readFile(file, 'utf8'), file);
    cases.push({ ...evalCase, fixture: evalCase.fixture ? path.join(dir, evalCase.fixture) : null });
  }
  return cases;
}

/** Run a process in `cwd`, feeding it `input`; never rejects (a spawn failure is a result). */
export function runProcess({ command, args, cwd, input = '', shell = false, timeoutMs, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: '', error: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let error = null;
    let settled = false;
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      error = err.message;
      settle(null);
    });
    child.on('close', (code) => settle(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Grade a finished run: the failed assertions, as readable strings (empty when it passed). */
export async function grade(assertions, { cwd, output, runCommand, timeoutMs }) {
  const failures = [];
  for (const assertion of assertions) {
    const label = assertion.type === 'command'
      ? `command \`${assertion.run}\``
      : [assertion.type, assertion.path, assertion.pattern].filter((part) => part !== undefined).join(' ');
    if (assertion.type === 'output-contains') {
      if (!new RegExp(assertion.pattern).test(output)) failures.push(label);
      continue;
    }
    if (assertion.type === 'command') {
      const result = await runCommand({ command: assertion.run, args: [], cwd, shell: true, timeoutMs });
      if (result.exitCode !== 0) failures.push(`${label} exited with ${result.error ?? result.exitCode}`);
      continue;
    }
    const content = await readIfExists(path.join(cwd, assertion.path));
    if (assertion.type === 'file-exists') {
      if (content === null) failures.push(label);
    } else if (assertion.type === 'file-contains') {
      if (content === null || !new RegExp(assertion.pattern).test(content)) failures.push(label);
    } else if (content !== null && new RegExp(assertion.pattern).test(content)) {
      failures.push(label);
    }
  }
  return failures;
}

async function prepareCheckout(evalCase, skill, variant, agent, { workDir, renderRepo }) {
  const cwd = await mkdtemp(path.join(workDir, `${variant}-`));
  if (evalCase.fixture) await cp(evalCase.fixture, cwd, { recursive: true });
  if (variant === 'skill') {
    for (const file of renderRepo([agent.target], [skill])) {
      const full = path.join(cwd, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.content);
    }
  }
  return cwd;
}

function rate(results) {
  return results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length;
}

/**
 * Evaluate `skill` (as resolveSkills returns it) on its eval cases. Returns, per case,
 * the baseline and with-skill runs and pass rates, and the overall delta.
 */
export async function evaluateSkill(skill, cases, options = {}) {
  const {
    agent: agentId = 'claude-cli',
    model = null,
    runs = 1,
    timeoutMs = DEFAULT_EVAL_TIMEOUT_MS,
    workDir: baseDir = tmpdir(),
    keep = false,
    renderRepo = defaultRenderRepo,
    runAgent = runProcess,
    runCommand = runProcess,
    logger = console,
  } = options;
  const agent = EVAL_AGENTS[agentId];
  if (!agent) throw new Error(`unknown eval agent: ${agentId} (expected one of ${Object.keys(EVAL_AGENTS).join(', ')})`);
  const args = model ? [...agent.args, '--model', model] : agent.args;
  await mkdir(baseDir, { recursive: true });
  const workDir = await mkdtemp(path.join(baseDir, `maggie-eval-${skill.name}-`));

  const report = { skill: skill.name, agent: agentId, model, runs, cases: [] };
  try {
    for (const evalCase of cases) {
      const entry = { name: evalCase.name, baseline: [], skill: [] };
      for (let run = 1; run <= runs; run += 1) {
        for (const variant of ['baseline', 'skill']) {
          const cwd = await prepareCheckout(evalCase, skill, variant, agent, { workDir, renderRepo });
          const result = await runAgent({ command: agent.command, args, cwd, input: evalCase.prompt, timeoutMs });
          const failures = result.error
            ? [`agent failed: ${result.error}`]
            : await grade(evalCase.assert, { cwd, output: result.stdout, runCommand, timeoutMs });
          entry[variant].push({ run, passed: failures.length === 0, failures, ...(result.error ? { agentError: result.error } : {}) });
          logger.log(`${failures.length === 0 ? '✓' : '✗'} ${skill.name} › ${evalCase.name} [${variant} #${run}]${failures.length ? `: ${failures.join('; ')}` : ''}`);
        }
      }
      entry.baselineRate = rate(entry.baseline);
      entry.skillRate = rate(entry.skill);
      entry.delta = entry.skillRate - entry.baselineRate;
      report.cases.push(entry);
    }
  } finally {
    if (!keep) await rm(workDir, { recursive: true, force: true });
  }
  report.baselineRate = rate(report.cases.flatMap((c) => c.baseline));
  report.skillRate = rate(report.cases.flatMap((c) => c.skill));
  report.delta = report.skillRate - report.baselineRate;
  report.agentErrors = report.cases.flatMap((c) => [...c.baseline, ...c.skill]).filter((r) => r.agentError).length;
  return report;
}

const percent = (value) => `${Math.round(value * 100)}%`;

/** One summary line per case and one for the skill, with a verdict. */
export function formatReport(report) {
  const lines = report.cases.map((c) => `  ${c.name}: ${percent(c.baselineRate)} → ${percent(c.skillRate)} (${c.delta >= 0 ? '+' : ''}${Math.round(c.delta * 100)} pts)`);
  let verdict = 'changes nothing measured by its evals — it only costs context';
  if (report.delta > 0) verdict = 'helps';
  else if (report.delta < 0) verdict = 'makes things worse';
  const out = [
    `${report.skill} (${report.agent}${report.model ? `, ${report.model}` : ''}, ${report.runs} run(s) per case):`,
    ...lines,
    `  overall: ${percent(report.baselineRate)} without the skill → ${percent(report.skillRate)} with it: ${verdict}`,
  ];
  if (report.agentErrors > 0) {
    out.push(`  ⚠ ${report.agentErrors} run(s) did not complete (the agent failed or timed out): the numbers above do not measure the skill`);
  }
  return out;
}
