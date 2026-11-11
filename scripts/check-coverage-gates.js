#!/usr/bin/env node
// Fails unless every Nx project under apps/, libs/ and .github/actions/ runs its tests behind a
// 100% coverage gate. Running the tests proves today's coverage; this proves
// nobody quietly lowered a threshold, dropped a coverage flag, or added a test
// runner that measures nothing. Run by the pre-push hook and by CI.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIRS = ['apps', 'libs', '.github/actions'];
const NODE_METRICS = ['lines', 'functions', 'branches'];
const VITEST_METRICS = ['lines', 'functions', 'branches', 'statements'];
const VITE_CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vitest.config.js', 'vitest.config.mjs'];

// Problems with one `node --test` command line, [] when it is gated at 100%.
export function checkNodeTestCommand(command) {
  if (!command.includes('--experimental-test-coverage')) {
    return [`\`${command}\` runs node:test without --experimental-test-coverage`];
  }
  return NODE_METRICS
    .filter((metric) => !new RegExp(`--test-coverage-${metric}=100(?!\\d)`).test(command))
    .map((metric) => `\`${command}\` does not require --test-coverage-${metric}=100`);
}

// Problems with a vitest `test` config block, [] when coverage runs on every
// `vitest run` and every metric is held at 100%.
export function checkVitestConfig(testConfig) {
  const coverage = testConfig.coverage ?? {};
  const problems = [];
  if (coverage.enabled !== true) problems.push('vitest coverage is not enabled (test.coverage.enabled: true)');
  const thresholds = coverage.thresholds ?? {};
  if (thresholds[100] !== true) {
    for (const metric of VITEST_METRICS) {
      if (thresholds[metric] !== 100) problems.push(`vitest test.coverage.thresholds.${metric} is not 100`);
    }
  }
  return problems;
}

// The shell commands the `test` target runs, following its dependsOn into the
// same project's targets (a `^target` is another project's, checked there).
export function collectTestCommands(targets, start = 'test') {
  const commands = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !targets[name]) return;
    seen.add(name);
    const { options = {}, dependsOn = [] } = targets[name];
    if (options.command) commands.push(options.command);
    for (const c of options.commands ?? []) commands.push(typeof c === 'string' ? c : c.command);
    for (const dep of dependsOn) {
      const target = typeof dep === 'string' ? dep : dep.target;
      if (!target.startsWith('^')) visit(target);
    }
  };
  visit(start);
  return commands;
}

// Problems with one project: { name, targets, vitest } where vitest is the
// `test` block of its vite config (or null when it has none).
export function checkProject({ name, targets, vitest }) {
  if (!targets.test) return [`${name}: no "test" target`];
  const problems = [];
  let gates = 0;
  for (const command of collectTestCommands(targets)) {
    if (/\bvitest\b/.test(command) && !vitest) problems.push(`${name}: \`${command}\` runs vitest without a vite config to gate it`);
    if (!/\bnode\b.*\s--test\b/.test(command)) continue;
    gates += 1;
    problems.push(...checkNodeTestCommand(command).map((p) => `${name}: ${p}`));
  }
  if (vitest) {
    gates += 1;
    problems.push(...checkVitestConfig(vitest).map((p) => `${name}: ${p}`));
  }
  if (gates === 0) problems.push(`${name}: the "test" target runs no coverage-gated test runner`);
  return problems;
}

function readTargets(dir) {
  const projectJson = path.join(dir, 'project.json');
  if (existsSync(projectJson)) {
    const project = JSON.parse(readFileSync(projectJson, 'utf8'));
    return { name: project.name, targets: project.targets ?? {} };
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return { name: pkg.nx?.name ?? pkg.name, targets: pkg.nx?.targets ?? {} };
}

async function readVitest(dir) {
  const file = VITE_CONFIGS.map((f) => path.join(dir, f)).find(existsSync);
  if (!file) return null;
  const config = (await import(pathToFileURL(file).href)).default;
  return config?.test ?? null;
}

// Every project directory under PROJECT_DIRS that Nx would pick up.
export function listProjectDirs(root) {
  const dirs = [];
  for (const parent of PROJECT_DIRS) {
    const base = path.join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const dir = path.join(base, entry.name);
      if (entry.isDirectory() && (existsSync(path.join(dir, 'project.json')) || existsSync(path.join(dir, 'package.json')))) {
        dirs.push(dir);
      }
    }
  }
  return dirs.sort();
}

export async function checkWorkspace(root = REPO_ROOT) {
  const projects = [];
  const problems = [];
  for (const dir of listProjectDirs(root)) {
    const { name, targets } = readTargets(dir);
    projects.push(name);
    problems.push(...checkProject({ name, targets, vitest: await readVitest(dir) }));
  }
  return { projects, problems };
}

async function runCli() {
  const { projects, problems } = await checkWorkspace();
  if (problems.length > 0) {
    console.error('Coverage gate check failed — every project must enforce 100% coverage:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 100% coverage gate enforced in ${projects.length} project(s): ${projects.join(', ')}`);
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (scriptPath === argPath) {
  runCli().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}
