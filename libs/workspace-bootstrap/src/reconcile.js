import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS, DEFAULT_AGENT, agentSpec } from './agents.js';
import { initRepos } from './board.js';

async function defaultExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function settingsPath(checkoutDir, agent) {
  return path.join(checkoutDir, ...agentSpec(agent).settingsFile);
}

async function defaultReadCurrentHooks(checkoutDir, agent, { read = readFile } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await read(settingsPath(checkoutDir, agent), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
  return agentSpec(agent).flattenHooks(parsed.hooks);
}

function hooksMatch(before, expectedHooks, agent) {
  if (!before) return false;
  const expected = agentSpec(agent).flattenHooks(expectedHooks);
  return Object.keys(expected).every((event) => before[event] === expected[event]);
}

// Which agents a checkout is wired for. A settings file already on disk is
// reconciled for that agent; a checkout with none at all falls back to Claude
// Code, which is what bootstrap installs by default.
async function detectAgents(checkout, exists) {
  const found = [];
  for (const agent of AGENTS) {
    if (await exists(settingsPath(checkout, agent))) found.push(agent);
  }
  return found.length > 0 ? found : [DEFAULT_AGENT];
}

// Every repo whose checkout already exists gets its hooks compared against
// what the agent's hookSettings() would produce today, and repointed if they
// differ (or don't exist yet). A repo's own failure is recorded, not thrown, so
// one bad repo can't stop the rest from being checked.
export async function reconcileHooks(config, options = {}) {
  const {
    boardPath,
    hookCommand,
    exists = defaultExists,
    readCurrentHooks = defaultReadCurrentHooks,
    installRepoHooks,
    initBoard = initRepos,
  } = options;

  // Assumes boardPath always follows bootstrap()'s <workspaceDir>/.maggie/board.json
  // layout (confirmed during design — see docs/superpowers/specs/2026-07-23-board-startup-hook-reconciliation-design.md).
  const workspaceDir = path.dirname(path.dirname(boardPath));
  const results = [];

  for (const repo of config.repos) {
    const checkout = repo.path ? path.resolve(repo.path) : path.join(workspaceDir, repo.name);
    try {
      if (!(await exists(checkout))) {
        results.push({ repo: repo.name, agent: DEFAULT_AGENT, status: 'skipped-missing', checkout });
        continue;
      }
      for (const agent of await detectAgents(checkout, exists)) {
        const spec = agentSpec(agent);
        const before = await readCurrentHooks(checkout, agent);
        const expected = spec.hookSettings(repo.name, boardPath, { command: hookCommand }).hooks;
        if (hooksMatch(before, expected, agent)) {
          results.push({ repo: repo.name, agent, status: 'up-to-date', checkout });
          continue;
        }
        await (installRepoHooks ?? spec.installHooks)(checkout, repo.name, boardPath, { command: hookCommand });
        results.push({ repo: repo.name, agent, status: 'repointed', checkout });
      }
    } catch (err) {
      results.push({ repo: repo.name, agent: DEFAULT_AGENT, status: 'error', error: err.message, checkout });
    }
  }

  await initBoard(boardPath, config.repos.map((r) => r.name));
  return results;
}
