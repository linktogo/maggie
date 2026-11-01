import { existsSync } from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.js';

/**
 * The repositories an agent may run in. Clients send a name, never a path: a
 * name maps to `repo.path` when the config pins one, otherwise to
 * `<workspace>/<name>` (the same rule as the workspace CLI).
 */
export function createRepoResolver({ repos, workspace, exists = existsSync }) {
  const byName = new Map(repos.map((repo) => [repo.name, repo]));
  return {
    names: () => [...byName.keys()],
    resolve(name) {
      const repo = byName.get(name);
      if (!repo) throw new AgentError('not-found', `unknown repository: ${String(name)}`);
      const dir = repo.path ? path.resolve(repo.path) : path.join(workspace, repo.name);
      if (!exists(dir)) throw new AgentError('not-found', `${repo.name} is not checked out at ${dir}`);
      return dir;
    },
  };
}
