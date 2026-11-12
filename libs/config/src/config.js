import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { knownTargets } from '@linktogo/maggie-renderers';
import { clone as defaultClone } from '@linktogo/maggie-git';

export async function loadConfig(filePath) {
  return parseConfig(await readFile(filePath, 'utf8'));
}

// Resolve where the CLI config comes from: a local file (`config`) or a git
// repository holding it (`configRepo`, e.g. an organization's shared config repo).
// Exactly one must be provided.
export async function resolveConfigSource(
  { config, configRepo, configFile } = {},
  { loadConfig: load = loadConfig, loadConfigFromRepo: loadFromRepo = loadConfigFromRepo } = {},
) {
  if (config && configRepo) {
    throw new Error('Pass either --config or --config-repo, not both');
  }
  if (configRepo) return loadFromRepo(configRepo, { configFile });
  if (config) return load(config);
  throw new Error('Missing required --config <path> or --config-repo <url>');
}

// Fetch the config from a separate git repository (e.g. an organization's
// shared config repo) instead of a local file. Shallow-clones into a temp dir, reads the
// config file, and removes the checkout afterwards.
export async function loadConfigFromRepo(repoUrl, { configFile = 'repos.json', clone = defaultClone } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maggie-config-'));
  const checkout = path.join(tmp, 'repo');
  try {
    await clone(toHttpsUrl(repoUrl), checkout, { depth: 1 });
    return parseConfig(await readFile(path.join(checkout, configFile), 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function parseConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config: ${err.message}`, { cause: err });
  }
  const valid = knownTargets();
  const defaultTargets = parsed.defaultTargets ?? [];
  validateTargets(defaultTargets, valid, 'defaultTargets');
  if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
    throw new Error('Config must define a non-empty "repos" array');
  }
  const repos = parsed.repos.map((repo, i) => normalizeRepo(repo, i, defaultTargets, valid));
  return { defaultTargets, repos };
}

function normalizeRepo(repo, index, defaultTargets, valid) {
  const label = repo.name ? `repos[${index}] (${repo.name})` : `repos[${index}]`;
  if (!repo.name) throw new Error(`repos[${index}]: missing "name"`);
  if (!repo.url) throw new Error(`${label}: missing "url"`);
  if (!Array.isArray(repo.technologies) || repo.technologies.length === 0) {
    throw new Error(`${label}: "technologies" must be a non-empty array`);
  }
  if (repo.path !== undefined && typeof repo.path !== 'string') {
    throw new Error(`${label}: "path" must be a string`);
  }
  const targets = repo.targets ?? defaultTargets;
  validateTargets(targets, valid, `${label}.targets`);
  if (targets.length === 0) {
    throw new Error(`${label}: no targets (set repo.targets or defaultTargets)`);
  }
  return {
    name: repo.name,
    url: toHttpsUrl(repo.url),
    technologies: repo.technologies,
    targets,
    ...(repo.path ? { path: repo.path } : {}),
  };
}

// Clone over HTTPS rather than SSH: rewrite scp-style and ssh:// URLs.
export function toHttpsUrl(url) {
  const scp = url.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = url.match(/^ssh:\/\/(?:[^@/]+@)?(.+)$/);
  if (ssh) return `https://${ssh[1]}`;
  return url;
}

function validateTargets(targets, valid, label) {
  if (!Array.isArray(targets)) throw new Error(`${label} must be an array`);
  for (const target of targets) {
    if (!valid.includes(target)) {
      throw new Error(`${label}: unknown target "${target}" (known: ${valid.join(', ')})`);
    }
  }
}
