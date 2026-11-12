#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLastTag, isReleasePending } from './detect-bump-type.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runCli() {
  const currentVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const lastTag = await getLastTag(REPO_ROOT);
  const pending = isReleasePending(currentVersion, lastTag);
  console.log(`pending=${pending}`);
  console.log(`tag=v${currentVersion}`);
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = realpathSync(process.argv[1]);
if (scriptPath === argPath) {
  runCli().catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}
