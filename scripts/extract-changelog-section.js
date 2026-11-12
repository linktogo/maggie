#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extractChangelogSection(changelogText, version) {
  const heading = `## [${version}]`;
  const start = changelogText.indexOf(heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for ${version}`);
  }
  const afterHeadingLine = changelogText.indexOf('\n', start) + 1;
  const stopPattern = /\n(## |\[[^\]]+\]: )/;
  const stopMatch = stopPattern.exec(changelogText.slice(afterHeadingLine));
  const end = stopMatch ? afterHeadingLine + stopMatch.index : changelogText.length;
  return changelogText.slice(afterHeadingLine, end).trim() + '\n';
}

function runCli() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/extract-changelog-section.js <vX.Y.Z>');
    process.exitCode = 1;
    return;
  }
  const version = tag.replace(/^v/, '');
  const changelog = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  process.stdout.write(extractChangelogSection(changelog, version));
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = realpathSync(process.argv[1]);
if (scriptPath === argPath) {
  runCli();
}
