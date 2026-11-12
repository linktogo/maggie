#!/usr/bin/env node
// Run by `pnpm install` (the root "prepare" script): points git at the hooks
// versioned in .githooks/, so the pre-push coverage gate is active in every
// clone without a manual step. A no-op outside a git checkout (a tarball, an
// `npm publish` from an exported tree) and when git is not installed.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HOOKS_PATH = '.githooks';

export function installGitHooks({ exec = execFileSync, log = console.log, cwd = process.cwd() } = {}) {
  try {
    exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
  } catch {
    return false;
  }
  exec('git', ['config', 'core.hooksPath', HOOKS_PATH], { cwd, stdio: 'ignore' });
  log(`git hooks: core.hooksPath set to ${HOOKS_PATH}`);
  return true;
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (scriptPath === argPath) installGitHooks();
