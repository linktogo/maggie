#!/usr/bin/env node
// `prepack` of the published apps: copy the skills library into the package, since a package can
// only ship files from its own folder. Usage: node scripts/stage-skills.js <package dir>
// (the copy is git-ignored; `postpack` removes it with --clean).
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stageSkills(packageDir, { clean = false, repoRoot = REPO_ROOT } = {}) {
  const target = path.join(packageDir, 'skills');
  rmSync(target, { recursive: true, force: true });
  if (!clean) cpSync(path.join(repoRoot, 'skills'), target, { recursive: true });
  return target;
}

export function runCli(argv) {
  const clean = argv.includes('--clean');
  const [dir] = argv.filter((arg) => arg !== '--clean');
  if (!dir) throw new Error('Usage: node scripts/stage-skills.js <package dir> [--clean]');
  return stageSkills(path.resolve(dir), { clean });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
