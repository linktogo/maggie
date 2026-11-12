import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function defaultExec(file, args, options) {
  const { stdout } = await execFileAsync(file, args, options);
  return stdout;
}

export function createRepo(dir, { exec = defaultExec } = {}) {
  const git = (...args) => exec('git', args, { cwd: dir });
  return {
    dir,
    async checkoutBranch(branch) {
      await git('checkout', '-B', branch);
    },
    async hasChanges() {
      const out = await exec('git', ['status', '--porcelain'], { cwd: dir });
      return out.trim().length > 0;
    },
    async commitAll(message) {
      await git('add', '-A');
      await git('commit', '-m', message);
    },
    async push(branch, { force = false } = {}) {
      const args = ['push'];
      if (force) args.push('-f');
      args.push('-u', 'origin', branch);
      await git(...args);
    },
    async createPR(title, body) {
      await exec('gh', ['pr', 'create', '--title', title, '--body', body], { cwd: dir });
    },
    async fetchReset(branch) {
      await git('fetch', 'origin', branch);
      await git('reset', '--hard', `origin/${branch}`);
    },
    async configureIdentity(name, email) {
      await git('config', 'user.name', name);
      await git('config', 'user.email', email);
    },
  };
}

export async function clone(url, dir, { exec = defaultExec, depth, branch } = {}) {
  const args = ['clone'];
  if (depth) args.push('--depth', String(depth));
  if (branch) args.push('--branch', branch, '--single-branch');
  // `--` ends option parsing: a URL from the config that starts with `-`
  // cannot be read as a git option (`--upload-pack=...`, for one).
  args.push('--', url, dir);
  await exec('git', args, {});
  return createRepo(dir, { exec });
}
