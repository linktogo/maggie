import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyCommits,
  isReleasePending,
  getLastTag,
  getCommitMessagesSince,
} from './detect-bump-type.js';

test('classifyCommits: feat-only commits produce a minor bump', () => {
  const { type, breaking } = classifyCommits(['feat: add thing', 'chore: tidy']);
  assert.equal(type, 'minor');
  assert.equal(breaking, false);
});

test('classifyCommits: fix-only commits produce a patch bump', () => {
  const { type, breaking } = classifyCommits(['fix: correct thing', 'docs: typo']);
  assert.equal(type, 'patch');
  assert.equal(breaking, false);
});

test('classifyCommits: feat and fix together produce a minor bump', () => {
  const { type } = classifyCommits(['fix: correct thing', 'feat: add thing']);
  assert.equal(type, 'minor');
});

test('classifyCommits: chore/docs-only commits produce no bump', () => {
  const { type, breaking } = classifyCommits(['chore: tidy', 'docs: update readme']);
  assert.equal(type, 'none');
  assert.equal(breaking, false);
});

test('classifyCommits: a "!" after the type flags a breaking change without forcing major', () => {
  const { type, breaking } = classifyCommits(['feat!: drop old API']);
  assert.equal(type, 'minor');
  assert.equal(breaking, true);
});

test('classifyCommits: a BREAKING CHANGE footer flags a breaking change', () => {
  const message = 'fix: correct thing\n\nBREAKING CHANGE: removes the old flag';
  const { type, breaking } = classifyCommits([message]);
  assert.equal(type, 'patch');
  assert.equal(breaking, true);
});

test('isReleasePending is false with no prior tag', () => {
  assert.equal(isReleasePending('1.0.0', null), false);
});

test('isReleasePending is false when the tag already matches the current version', () => {
  assert.equal(isReleasePending('1.0.0', 'v1.0.0'), false);
});

test('isReleasePending is true when the current version is ahead of the last tag', () => {
  assert.equal(isReleasePending('1.1.0', 'v1.0.0'), true);
});

function configureGit(dir) {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.dev']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'detect-'));
  execFileSync('git', ['init', '-q', dir]);
  configureGit(dir);
  return dir;
}

function commit(dir, message) {
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', message]);
}

test('getLastTag returns null when the repo has no tags', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  assert.equal(await getLastTag(dir), null);
});

test('getLastTag returns the most recent v* tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  execFileSync('git', ['-C', dir, 'tag', 'v1.0.0']);
  commit(dir, 'feat: add thing');
  assert.equal(await getLastTag(dir), 'v1.0.0');
});

test('getCommitMessagesSince returns full history when there is no tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  commit(dir, 'feat: add thing');
  const messages = await getCommitMessagesSince(dir, null);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.startsWith('feat: add thing')));
});

test('getCommitMessagesSince only returns commits after the given tag', async () => {
  const dir = await makeRepo();
  commit(dir, 'chore: init');
  execFileSync('git', ['-C', dir, 'tag', 'v1.0.0']);
  commit(dir, 'feat: add thing');
  const messages = await getCommitMessagesSince(dir, 'v1.0.0');
  assert.equal(messages.length, 1);
  assert.ok(messages[0].startsWith('feat: add thing'));
});
