#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/linktogo/maggie';

export function computeNextVersion(currentVersion, bumpType) {
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  if (bumpType === 'major') return `${major + 1}.0.0`;
  if (bumpType === 'minor') return `${major}.${minor + 1}.0`;
  if (bumpType === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump type: ${bumpType}`);
}

function readManifestDirs(base) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name, 'package.json'));
}

export function listWorkspaceManifests(repoRoot) {
  const libs = readManifestDirs(path.join(repoRoot, 'libs'));
  const apps = readManifestDirs(path.join(repoRoot, 'apps'));
  const root = path.join(repoRoot, 'package.json');
  return { versioned: [root, ...libs], all: [root, ...libs, ...apps] };
}

export function bumpManifestVersion(filePath, newVersion) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
}

export function updateInternalDependencyRanges(filePath, newVersion) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
  const deps = pkg.dependencies;
  if (!deps) return;
  let changed = false;
  for (const name of Object.keys(deps)) {
    if (!name.startsWith('@linktogo/maggie-')) continue;
    const next = `^${newVersion}`;
    if (deps[name] !== next) {
      deps[name] = next;
      changed = true;
    }
  }
  if (changed) writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function updateChangelog(changelogText, { oldVersion, newVersion, date, repoUrl = REPO_URL }) {
  const heading = '## [Unreleased]';
  const idx = changelogText.indexOf(heading);
  if (idx === -1) throw new Error('CHANGELOG.md has no [Unreleased] section');
  const insertAt = idx + heading.length;
  const withHeading =
    changelogText.slice(0, insertAt) + `\n\n## [${newVersion}] - ${date}` + changelogText.slice(insertAt);

  const unreleasedLinkRe = /^\[Unreleased\]: .*$/m;
  const oldVersionLinkRe = new RegExp(`^\\[${escapeRegExp(oldVersion)}\\]: .*$`, 'm');
  const newUnreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD`;
  const newVersionLink = oldVersionLinkRe.test(withHeading)
    ? `[${newVersion}]: ${repoUrl}/compare/v${oldVersion}...v${newVersion}`
    : `[${newVersion}]: ${repoUrl}/releases/tag/v${newVersion}`;

  return withHeading.replace(unreleasedLinkRe, `${newUnreleasedLink}\n${newVersionLink}`);
}

function runCli() {
  const [bumpType, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  if (!['major', 'minor', 'patch'].includes(bumpType)) {
    console.error('Usage: node scripts/bump-version.js <major|minor|patch> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const rootPkgPath = path.join(REPO_ROOT, 'package.json');
  const currentVersion = JSON.parse(readFileSync(rootPkgPath, 'utf8')).version;
  const newVersion = computeNextVersion(currentVersion, bumpType);
  const { versioned, all } = listWorkspaceManifests(REPO_ROOT);
  const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
  const today = new Date().toISOString().slice(0, 10);

  console.log(`${currentVersion} -> ${newVersion}`);
  if (dryRun) {
    console.log('Would update:', all.map((f) => path.relative(REPO_ROOT, f)).join(', '));
    console.log('Would update: CHANGELOG.md');
    return;
  }

  for (const file of versioned) bumpManifestVersion(file, newVersion);
  for (const file of all) updateInternalDependencyRanges(file, newVersion);

  const changelog = readFileSync(changelogPath, 'utf8');
  writeFileSync(changelogPath, updateChangelog(changelog, { oldVersion: currentVersion, newVersion, date: today }));

  execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log('\nDone. Next steps:');
  console.log(`  git add -A && git commit -m "chore(release): v${newVersion}"`);
  console.log('  git push -u origin HEAD, then open a PR');
}

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const argPath = realpathSync(process.argv[1]);
if (scriptPath === argPath) {
  runCli();
}
