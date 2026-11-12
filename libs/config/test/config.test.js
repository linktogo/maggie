import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { parseConfig, loadConfig, loadConfigFromRepo, resolveConfigSource, toHttpsUrl } from '../src/config.js';

test('parseConfig resolves repo targets, falling back to defaultTargets', () => {
  const cfg = parseConfig(JSON.stringify({
    defaultTargets: ['claude', 'copilot'],
    repos: [
      { name: 'a', url: 'u1', technologies: ['nestjs'] },
      { name: 'b', url: 'u2', technologies: ['react'], targets: ['cursor'] },
    ],
  }));
  assert.deepEqual(cfg.repos[0].targets, ['claude', 'copilot']);
  assert.deepEqual(cfg.repos[1].targets, ['cursor']);
});

test('parseConfig rejects invalid JSON', () => {
  assert.throws(() => parseConfig('{not json'), /Invalid JSON in config/);
});

test('parseConfig requires a non-empty repos array', () => {
  assert.throws(() => parseConfig('{"repos": []}'), /non-empty "repos" array/);
});

test('parseConfig rejects unknown default targets', () => {
  assert.throws(
    () => parseConfig('{"defaultTargets":["bad"],"repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /unknown target "bad"/,
  );
});

test('parseConfig rejects unknown per-repo targets', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"],"targets":["bad"]}]}'),
    /unknown target "bad"/,
  );
});

test('parseConfig requires name', () => {
  assert.throws(() => parseConfig('{"repos":[{"url":"u","technologies":["t"]}]}'), /missing "name"/);
});

test('parseConfig requires url', () => {
  assert.throws(() => parseConfig('{"repos":[{"name":"a","technologies":["t"]}]}'), /missing "url"/);
});

test('parseConfig requires non-empty technologies', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":[]}]}'),
    /"technologies" must be a non-empty array/,
  );
});

test('parseConfig rejects a repo that ends up with no targets', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /no targets/,
  );
});

test('parseConfig rejects non-array defaultTargets', () => {
  assert.throws(
    () => parseConfig('{"defaultTargets":"claude","repos":[{"name":"a","url":"u","technologies":["t"]}]}'),
    /must be an array/,
  );
});

test('toHttpsUrl rewrites scp-style SSH urls to https', () => {
  assert.equal(
    toHttpsUrl('git@github.com:linktog/repo1.git'),
    'https://github.com/linktog/repo1.git',
  );
});

test('toHttpsUrl rewrites ssh:// urls to https', () => {
  assert.equal(
    toHttpsUrl('ssh://git@github.com/linktog/repo1.git'),
    'https://github.com/linktog/repo1.git',
  );
});

test('toHttpsUrl leaves https urls untouched', () => {
  assert.equal(
    toHttpsUrl('https://github.com/linktog/repo1.git'),
    'https://github.com/linktog/repo1.git',
  );
});

test('parseConfig normalizes a repo SSH url to https', () => {
  const cfg = parseConfig(JSON.stringify({
    repos: [{ name: 'a', url: 'git@github.com:org/a.git', technologies: ['t'], targets: ['claude'] }],
  }));
  assert.equal(cfg.repos[0].url, 'https://github.com/org/a.git');
});

test('loadConfig reads and parses a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cfg-'));
  const file = path.join(dir, 'repos.json');
  await writeFile(file, '{"defaultTargets":["claude"],"repos":[{"name":"a","url":"u","technologies":["t"]}]}');
  const cfg = await loadConfig(file);
  assert.equal(cfg.repos[0].name, 'a');
});

const REPO_CONFIG = '{"defaultTargets":["claude"],"repos":[{"name":"z","url":"u","technologies":["t"]}]}';

test('loadConfigFromRepo shallow-clones the repo, reads repos.json by default, and cleans up', async () => {
  let cloneCall;
  let clonedDir;
  const clone = async (url, dir, opts) => {
    cloneCall = { url, dir, opts };
    clonedDir = dir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'repos.json'), REPO_CONFIG);
    return {};
  };
  const cfg = await loadConfigFromRepo('git@github.com:example-org/ai-config.git', { clone });
  assert.equal(cfg.repos[0].name, 'z');
  // SSH url rewritten to https, shallow depth requested
  assert.equal(cloneCall.url, 'https://github.com/example-org/ai-config.git');
  assert.equal(cloneCall.opts.depth, 1);
  // temp checkout removed afterwards
  await assert.rejects(() => stat(clonedDir), /ENOENT/);
});

test('loadConfigFromRepo honors a custom configFile path', async () => {
  // Only writes to the custom name; a default 'repos.json' read would ENOENT.
  const clone = async (url, dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'other.json'), REPO_CONFIG);
    return {};
  };
  const cfg = await loadConfigFromRepo('https://github.com/o/c.git', { configFile: 'other.json', clone });
  assert.equal(cfg.repos[0].name, 'z');
});

test('loadConfigFromRepo still cleans up when the config file is missing', async () => {
  let clonedDir;
  const clone = async (url, dir) => { clonedDir = dir; return {}; };
  await assert.rejects(
    () => loadConfigFromRepo('https://github.com/o/c.git', { clone }),
    /ENOENT/,
  );
  await assert.rejects(() => stat(clonedDir), /ENOENT/);
});

test('resolveConfigSource errors when neither config nor configRepo is given', async () => {
  await assert.rejects(
    () => resolveConfigSource({}, { loadConfig: async () => {}, loadConfigFromRepo: async () => {} }),
    /Missing required --config <path> or --config-repo <url>/,
  );
});

test('resolveConfigSource errors when both config and configRepo are given', async () => {
  await assert.rejects(
    () => resolveConfigSource(
      { config: 'a', configRepo: 'b' },
      { loadConfig: async () => {}, loadConfigFromRepo: async () => {} },
    ),
    /Pass either --config or --config-repo, not both/,
  );
});

test('resolveConfigSource reads a local file when config is given', async () => {
  let seen;
  const cfg = await resolveConfigSource(
    { config: '/path/repos.json' },
    { loadConfig: async (p) => { seen = p; return { ok: true }; }, loadConfigFromRepo: async () => { throw new Error('no'); } },
  );
  assert.equal(seen, '/path/repos.json');
  assert.deepEqual(cfg, { ok: true });
});

test('resolveConfigSource clones the config repo when configRepo is given, forwarding configFile', async () => {
  let seen;
  const cfg = await resolveConfigSource(
    { configRepo: 'https://x/c.git', configFile: 'sub/repos.json' },
    { loadConfig: async () => { throw new Error('no'); }, loadConfigFromRepo: async (url, opts) => { seen = { url, opts }; return { ok: true }; } },
  );
  assert.equal(seen.url, 'https://x/c.git');
  assert.equal(seen.opts.configFile, 'sub/repos.json');
  assert.deepEqual(cfg, { ok: true });
});

test('parseConfig passes through an optional path field', () => {
  const cfg = parseConfig(JSON.stringify({
    repos: [{ name: 'a', url: 'u', path: '/tmp/checkouts/a', technologies: ['t'], targets: ['claude'] }],
  }));
  assert.equal(cfg.repos[0].path, '/tmp/checkouts/a');
});

test('parseConfig omits path when not provided', () => {
  const cfg = parseConfig(JSON.stringify({
    repos: [{ name: 'a', url: 'u', technologies: ['t'], targets: ['claude'] }],
  }));
  assert.equal('path' in cfg.repos[0], false);
});

test('parseConfig rejects a non-string path', () => {
  assert.throws(
    () => parseConfig('{"repos":[{"name":"a","url":"u","technologies":["t"],"targets":["claude"],"path":123}]}'),
    /"path" must be a string/,
  );
});
