import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir as fsMkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';

const MAX_SLUG_LENGTH = 40;
export const GIT_TIMEOUT_MS = 60_000;

/** ASCII branch-name fragment from a title: `[a-z0-9-]`, at most 40 characters, `task` when nothing is left. */
export function slugify(title) {
  const slug = String(title)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug || 'task';
}

/**
 * Git worktrees for threads: one per thread under `<workspace>/.worktrees/<repo>/<threadId>`,
 * on a `factory/<threadId>-<slug>` branch cut from `origin/<default>`. Git always runs through
 * `execFile` with an argument array, never a shell.
 */
export function createWorktreeManager({
  workspace, execFile = promisify(nodeExecFile), exists = existsSync, mkdir = fsMkdir, timeoutMs = GIT_TIMEOUT_MS, log = () => {},
}) {
  // Git locks a repository's worktree list: creates and removes of one repository run one at a time.
  const queues = new Map(); // repoDir -> tail of its promise chain
  function serial(repoDir, work) {
    const result = (queues.get(repoDir) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => {}); // a failure never breaks the chain
    queues.set(repoDir, tail);
    void tail.then(() => {
      if (queues.get(repoDir) === tail) queues.delete(repoDir);
    });
    return result;
  }

  async function git(args, prefix = '') {
    try {
      // Never wait on a credential prompt, and never hang on a stuck remote.
      const { stdout } = await execFile('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs });
      return String(stdout).trim();
    } catch (err) {
      throw new AgentError('git', `${prefix}${String(err.stderr ?? '').trim() || err.message}`);
    }
  }

  // Fails closed: a branch is only ever deleted on a clean, parsed `0`.
  const commitsAhead = async (cwd, range) => {
    const out = await git(['-C', cwd, 'rev-list', '--count', range]);
    if (!/^\d+$/.test(out)) throw new AgentError('git', `unexpected rev-list output: ${out}`);
    return Number(out);
  };

  return {
    create: ({ repo, repoDir, threadId, title }) => serial(repoDir, async () => {
      await git(['-C', repoDir, 'fetch', 'origin'], 'git fetch failed: ');
      let base;
      try {
        base = await git(['-C', repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      } catch {
        throw new AgentError('invalid', `${repo} has no origin/HEAD; run \`git remote set-head origin -a\` in the repository`);
      }
      const branch = `factory/${threadId}-${slugify(title)}`;
      const dir = path.join(workspace, '.worktrees', repo, threadId);
      await mkdir(path.dirname(dir), { recursive: true });
      await git(['-C', repoDir, 'worktree', 'add', '-b', branch, dir, base]);
      return { path: dir, branch, base };
    }),

    async status({ path: dir, base }) {
      if (!exists(dir)) return { exists: false, dirty: false, ahead: 0 };
      const porcelain = await git(['-C', dir, 'status', '--porcelain']);
      return { exists: true, dirty: porcelain !== '', ahead: await commitsAhead(dir, `${base}..HEAD`) };
    },

    remove: ({ repoDir, path: dir, branch, base, force = false }) => serial(repoDir, async () => {
      const present = exists(dir);
      if (present && !force && (await git(['-C', dir, 'status', '--porcelain'])) !== '') {
        throw new AgentError('dirty', 'the worktree has uncommitted changes');
      }
      await git(present
        ? ['-C', repoDir, 'worktree', 'remove', ...(force ? ['--force'] : []), dir]
        : ['-C', repoDir, 'worktree', 'prune']);
      // The worktree is gone now: a branch that cannot be counted or deleted is kept, never fatal.
      try {
        if ((await commitsAhead(repoDir, `${base}..${branch}`)) > 0) return { branchKept: true };
        await git(['-C', repoDir, 'branch', '-D', branch]);
        return { branchKept: false };
      } catch (err) {
        log(`worktree ${dir}: branch ${branch} kept: ${err.message}`);
        return { branchKept: true };
      }
    }),
  };
}
