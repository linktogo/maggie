import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function makeRepo(version) {
  const root = await mkdtemp(path.join(tmpdir(), 'should-tag-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(path.join(SCRIPT_DIR, 'should-tag-release.js'), path.join(root, 'scripts', 'should-tag-release.js'));
  await copyFile(path.join(SCRIPT_DIR, 'detect-bump-type.js'), path.join(root, 'scripts', 'detect-bump-type.js'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', version, type: 'module' }, null, 2));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'chore: init']);
  return root;
}

function run(root) {
  return execFileSync('node', [path.join(root, 'scripts', 'should-tag-release.js')], {
    encoding: 'utf8',
    cwd: root,
  });
}

test('reports no pending tag when there is no prior tag', async () => {
  const root = await makeRepo('1.0.0');
  const out = run(root);
  assert.match(out, /^pending=false$/m);
  assert.match(out, /^tag=v1\.0\.0$/m);
});

test('reports no pending tag when the last tag already matches package.json', async () => {
  const root = await makeRepo('1.0.0');
  execFileSync('git', ['-C', root, 'tag', 'v1.0.0']);
  const out = run(root);
  assert.match(out, /^pending=false$/m);
});

test('reports a pending tag when package.json is ahead of the last tag', async () => {
  const root = await makeRepo('1.0.0');
  execFileSync('git', ['-C', root, 'tag', 'v1.0.0']);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', version: '1.1.0', type: 'module' }, null, 2),
  );

  const out = run(root);
  assert.match(out, /^pending=true$/m);
  assert.match(out, /^tag=v1\.1\.0$/m);
});
