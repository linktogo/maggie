import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNextVersion,
  listWorkspaceManifests,
  bumpManifestVersion,
  updateInternalDependencyRanges,
  updateChangelog,
} from './bump-version.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

test('computeNextVersion bumps the right segment and zeroes the rest', () => {
  assert.equal(computeNextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(computeNextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(computeNextVersion('1.2.3', 'patch'), '1.2.4');
});

test('computeNextVersion rejects an unknown bump type', () => {
  assert.throws(() => computeNextVersion('1.2.3', 'banana'), /Unknown bump type/);
});

test('listWorkspaceManifests finds root, libs, and apps package.json files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await mkdir(path.join(root, 'libs', 'b'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'c'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'b', 'package.json'), '{}');
  await writeFile(path.join(root, 'apps', 'c', 'package.json'), '{}');

  const { versioned, all } = listWorkspaceManifests(root);

  assert.deepEqual(
    versioned.sort(),
    [
      path.join(root, 'package.json'),
      path.join(root, 'libs', 'a', 'package.json'),
      path.join(root, 'libs', 'b', 'package.json'),
      path.join(root, 'apps', 'c', 'package.json'),
    ].sort(),
  );
  assert.deepEqual(
    all.sort(),
    [
      path.join(root, 'package.json'),
      path.join(root, 'libs', 'a', 'package.json'),
      path.join(root, 'libs', 'b', 'package.json'),
      path.join(root, 'apps', 'c', 'package.json'),
    ].sort(),
  );
});

test('listWorkspaceManifests skips directories without a package.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'apps', 'server'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'landing-page'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'apps', 'server', 'package.json'), '{}');
  await writeFile(path.join(root, 'apps', 'landing-page', 'index.html'), '<html></html>');

  const { versioned, all } = listWorkspaceManifests(root);

  const expected = [path.join(root, 'package.json'), path.join(root, 'apps', 'server', 'package.json')].sort();
  assert.deepEqual(versioned.sort(), expected);
  assert.deepEqual(all.sort(), expected);
});

test('listWorkspaceManifests tolerates a missing apps directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{}');

  const { all } = listWorkspaceManifests(root);

  assert.deepEqual(all.sort(), [
    path.join(root, 'package.json'),
    path.join(root, 'libs', 'a', 'package.json'),
  ].sort());
});

test('bumpManifestVersion updates only the version field', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  await writeFile(
    file,
    JSON.stringify({ name: 'x', version: '1.2.3', dependencies: { y: '^1.0.0' } }, null, 2) + '\n',
  );

  bumpManifestVersion(file, '1.3.0');

  const pkg = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pkg.version, '1.3.0');
  assert.equal(pkg.name, 'x');
  assert.deepEqual(pkg.dependencies, { y: '^1.0.0' });
});

test('updateInternalDependencyRanges bumps only @lk/maggie-* deps', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  await writeFile(
    file,
    JSON.stringify(
      { name: 'x', version: '1.2.3', dependencies: { '@lk/maggie-git': '^1.2.3', 'gray-matter': '^4.0.3' } },
      null,
      2,
    ) + '\n',
  );

  updateInternalDependencyRanges(file, '1.3.0');

  const pkg = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pkg.dependencies['@lk/maggie-git'], '^1.3.0');
  assert.equal(pkg.dependencies['gray-matter'], '^4.0.3');
});

test('updateInternalDependencyRanges is a no-op when there are no dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  const file = path.join(root, 'package.json');
  const original = JSON.stringify({ name: 'x', version: '1.2.3' }, null, 2) + '\n';
  await writeFile(file, original);

  updateInternalDependencyRanges(file, '1.3.0');

  assert.equal(await readFile(file, 'utf8'), original);
});

test('updateChangelog moves Unreleased under a new version heading and updates links', () => {
  const input = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- Something new.',
    '',
    '## [0.1.0]',
    '',
    'Initial release.',
    '',
    '[Unreleased]: https://github.com/linktogo/maggie/compare/v0.1.0...HEAD',
    '[0.1.0]: https://github.com/linktogo/maggie/releases/tag/v0.1.0',
    '',
  ].join('\n');

  const out = updateChangelog(input, { oldVersion: '0.1.0', newVersion: '0.2.0', date: '2026-08-10' });

  assert.match(out, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-08-10\n\n### Added/);
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/linktogo\/maggie\/compare\/v0\.2\.0\.\.\.HEAD/);
  assert.match(out, /\[0\.2\.0\]: https:\/\/github\.com\/linktogo\/maggie\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.match(out, /\[0\.1\.0\]: https:\/\/github\.com\/linktogo\/maggie\/releases\/tag\/v0\.1\.0/);
});

test('updateChangelog falls back to a releases/tag link when there is no prior version link', () => {
  const input = [
    '## [Unreleased]',
    '',
    '- First entry.',
    '',
    '[Unreleased]: https://github.com/linktogo/maggie/compare/v0.1.0...HEAD',
    '',
  ].join('\n');

  const out = updateChangelog(input, { oldVersion: '0.1.0', newVersion: '0.2.0', date: '2026-08-10' });

  assert.match(out, /\[0\.2\.0\]: https:\/\/github\.com\/linktogo\/maggie\/releases\/tag\/v0\.2\.0/);
});

test('CLI dry-run reports the computed bump without writing any file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bump-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true });
  await copyFile(path.join(SCRIPT_DIR, 'bump-version.js'), path.join(root, 'scripts', 'bump-version.js'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.2.3', type: 'module' }, null, 2));
  await writeFile(
    path.join(root, 'libs', 'a', 'package.json'),
    JSON.stringify({ name: 'a', version: '1.2.3' }, null, 2),
  );
  await writeFile(
    path.join(root, 'CHANGELOG.md'),
    '## [Unreleased]\n\n- x\n\n[Unreleased]: https://github.com/linktogo/maggie/compare/v1.2.3...HEAD\n',
  );

  const out = execFileSync('node', [path.join(root, 'scripts', 'bump-version.js'), 'minor', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.match(out, /1\.2\.3 -> 1\.3\.0/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '1.2.3');
});

test('CLI rejects a missing or invalid bump type', () => {
  assert.throws(() => execFileSync('node', [path.join(SCRIPT_DIR, 'bump-version.js')], { encoding: 'utf8' }));
});
