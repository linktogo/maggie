import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, stalePaths } from '../src/manifest.js';

test('readManifest returns an empty manifest when the file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: [] });
});

test('readManifest returns the parsed paths when the file is valid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(
    path.join(dir, '.maggie/manifest.json'),
    JSON.stringify({ version: 1, paths: ['b.md', 'a.md'] }),
  );
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: ['b.md', 'a.md'] });
});

test('readManifest defaults the version when the manifest omits it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), JSON.stringify({ paths: ['x.md'] }));
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: ['x.md'] });
});

test('readManifest defaults paths to an empty array when the field is missing or not an array', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), JSON.stringify({ version: 1, paths: 'not-an-array' }));
  const manifest = await readManifest(dir);
  assert.deepEqual(manifest, { version: 1, paths: [] });
});

test('readManifest treats invalid JSON as no manifest and warns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), '{ not json');
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON, treating as no manifest/);
});

test('readManifest rethrows non-ENOENT filesystem errors (e.g. ENOTDIR when .maggie is a file)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeFile(path.join(dir, '.maggie'), 'not a directory');
  await assert.rejects(() => readManifest(dir), (err) => err.code !== 'ENOENT');
});

test('readManifest rejects a top-level JSON array with a not-a-JSON-object warning', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), JSON.stringify([1, 2, 3]));
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /manifest is not a JSON object/);
});

test('readManifest rejects null JSON with a not-a-JSON-object warning (not invalid-JSON)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), 'null');
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /manifest is not a JSON object/);
  assert.doesNotMatch(warnings[0], /invalid JSON/);
});

test('readManifest treats an empty file as invalid JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(path.join(dir, '.maggie/manifest.json'), '');
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON, treating as no manifest/);
});

test('readManifest filters out parent-directory traversal paths and warns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(
    path.join(dir, '.maggie/manifest.json'),
    JSON.stringify({ version: 1, paths: ['ok.md', '../../etc/passwd'] }),
  );
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: ['ok.md'] });
  assert.ok(warnings.some((w) => /ignoring 1 unsafe path/.test(w)));
});

test('readManifest filters out absolute paths and warns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(
    path.join(dir, '.maggie/manifest.json'),
    JSON.stringify({ version: 1, paths: ['ok.md', '/etc/passwd'] }),
  );
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: ['ok.md'] });
  assert.ok(warnings.some((w) => /ignoring 1 unsafe path/.test(w)));
});

test('readManifest filters out bare parent-directory references and non-strings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await mkdir(path.join(dir, '.maggie'), { recursive: true });
  await writeFile(
    path.join(dir, '.maggie/manifest.json'),
    JSON.stringify({ version: 1, paths: ['ok.md', '..', '', 42] }),
  );
  const warnings = [];
  const manifest = await readManifest(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(manifest, { version: 1, paths: ['ok.md'] });
  assert.ok(warnings.some((w) => /ignoring 3 unsafe path/.test(w)));
});

test('writeManifest writes a sorted paths array under the schema version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeManifest(dir, ['z.md', 'a.md', 'm.md']);
  const raw = await readFile(path.join(dir, '.maggie/manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, paths: ['a.md', 'm.md', 'z.md'] });
});

test('writeManifest creates the .maggie directory if it does not exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-'));
  await writeManifest(dir, []);
  const raw = await readFile(path.join(dir, '.maggie/manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, paths: [] });
});

test('stalePaths returns entries in oldPaths absent from newPaths', () => {
  assert.deepEqual(stalePaths(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

test('stalePaths returns an empty array when nothing is stale', () => {
  assert.deepEqual(stalePaths(['a', 'b'], ['a', 'b', 'c']), []);
});

test('stalePaths returns everything when newPaths is empty', () => {
  assert.deepEqual(stalePaths(['a', 'b'], []), ['a', 'b']);
});
