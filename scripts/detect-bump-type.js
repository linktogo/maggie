#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function classifyCommits(messages) {
  let sawFeat = false;
  let sawFix = false;
  let breaking = false;
  const headerRe = /^(\w+)(\([^)]*\))?(!)?:\s/;
  for (const message of messages) {
    const header = message.split('\n')[0];
    const match = headerRe.exec(header);
    if (!match) continue;
    const [, type, , bang] = match;
    if (type === 'feat') sawFeat = true;
    if (type === 'fix') sawFix = true;
    if (bang || /BREAKING CHANGE:/.test(message)) breaking = true;
  }
  const type = sawFeat ? 'minor' : sawFix ? 'patch' : 'none';
  return { type, breaking };
}

export function isReleasePending(currentVersion, lastTag) {
  return Boolean(lastTag) && lastTag !== `v${currentVersion}`;
}

export async function defaultExec(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

export async function getLastTag(repoRoot, { exec = defaultExec } = {}) {
  try {
    const out = await exec(['describe', '--tags', '--abbrev=0', '--match', 'v*'], repoRoot);
    return out.trim();
  } catch {
    return null;
  }
}

export async function getCommitMessagesSince(repoRoot, lastTag, { exec = defaultExec } = {}) {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const out = await exec(['log', range, '--pretty=%B%x00'], repoRoot);
  return out
    .split('\0')
    .map((m) => m.trim())
    .filter(Boolean);
}

async function runCli() {
  const currentVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const lastTag = await getLastTag(REPO_ROOT);

  if (isReleasePending(currentVersion, lastTag)) {
    console.log('type=none');
    console.log('breaking=false');
    return;
  }

  const messages = await getCommitMessagesSince(REPO_ROOT, lastTag);
  const { type, breaking } = classifyCommits(messages);
  console.log(`type=${type}`);
  console.log(`breaking=${breaking}`);
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = realpathSync(process.argv[1]);
if (scriptPath === argPath) {
  runCli().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}
