import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeStateFile, trustDirectories } from '../src/trust.js';

async function stateFile(t, content) {
  const dir = await mkdtemp(path.join(tmpdir(), 'trust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  if (content !== undefined) await writeFile(file, content);
  return file;
}

const read = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('the state file lives in the home directory', () => {
  assert.equal(claudeStateFile('/h'), path.join('/h', '.claude.json'));
  assert.equal(path.basename(claudeStateFile()), '.claude.json');
});

test('trusting adds the directories and keeps everything else in the file', async (t) => {
  const file = await stateFile(t, JSON.stringify({ theme: 'dark', projects: { '/a': { allowedTools: ['x'] }, '/b': { hasTrustDialogAccepted: true } } }));
  const added = await trustDirectories(['/a', '/b', '/c'], { file });
  assert.deepEqual(added, ['/a', '/c']);
  assert.deepEqual(await read(file), {
    theme: 'dark',
    projects: { '/a': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: true }, '/c': { hasTrustDialogAccepted: true } },
  });
});

test('a missing file is created, a file without projects gets them', async (t) => {
  const missing = await stateFile(t);
  assert.deepEqual(await trustDirectories(['/a'], { file: missing }), ['/a']);
  assert.deepEqual(await read(missing), { projects: { '/a': { hasTrustDialogAccepted: true } } });
  const bare = await stateFile(t, '{"theme":"dark"}');
  await trustDirectories(['/a'], { file: bare });
  assert.deepEqual(await read(bare), { theme: 'dark', projects: { '/a': { hasTrustDialogAccepted: true } } });
});

test('nothing is written when every directory is already trusted', async (t) => {
  const content = '{"projects":{"/a":{"hasTrustDialogAccepted":true}}}';
  const file = await stateFile(t, content);
  assert.deepEqual(await trustDirectories(['/a'], { file }), []);
  assert.equal(await readFile(file, 'utf8'), content);
});

test('an unreadable state file is reported, never overwritten', async (t) => {
  const file = await stateFile(t, '{ not json');
  await assert.rejects(trustDirectories(['/a'], { file }), /not readable JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ not json');
});
