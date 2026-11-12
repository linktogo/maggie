import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');

// Pushing from a worktree, git exports GIT_DIR to the hook. Inherited by the
// test suites, it redirected their fixture repos' `git -C <tmp>` calls to the
// real checkout: a fixture's `commit -m init` and `push origin HEAD:main` once
// landed on the real main. The hook must hand its commands a clean environment.
test('the pre-push hook strips the repository-locating GIT_* variables before running the checks', async () => {
  const bin = await mkdtemp(path.join(tmpdir(), 'pre-push-'));
  const dump = path.join(bin, 'env.txt');
  for (const name of ['node', 'pnpm']) {
    const fake = path.join(bin, name);
    await writeFile(fake, `#!/bin/sh\necho "${name}" >> "${dump}"\nenv | grep '^GIT_' >> "${dump}" || true\n`);
    await chmod(fake, 0o755);
  }
  const leaked = {
    GIT_DIR: '/repo/.git/worktrees/wt',
    GIT_WORK_TREE: '/repo',
    GIT_INDEX_FILE: '/repo/.git/index',
    GIT_OBJECT_DIRECTORY: '/repo/.git/objects',
    GIT_COMMON_DIR: '/repo/.git',
    GIT_PREFIX: 'sub/',
  };
  execFileSync('sh', [HOOK], { env: { PATH: `${bin}:/usr/bin:/bin`, ...leaked, GIT_SSL_CAINFO: '/ca.crt' }, stdio: 'ignore' });

  const seen = await readFile(dump, 'utf8');
  assert.match(seen, /^node$/m, 'the coverage-gate check ran');
  assert.match(seen, /^pnpm$/m, 'the test suites ran');
  for (const name of Object.keys(leaked)) assert.doesNotMatch(seen, new RegExp(`^${name}=`, 'm'), `${name} leaked`);
  assert.match(seen, /^GIT_SSL_CAINFO=\/ca\.crt$/m, 'unrelated GIT_* settings are kept');
  await rm(bin, { recursive: true, force: true });
});
