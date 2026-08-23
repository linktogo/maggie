import path from 'node:path';
import { mkdir, access, rm } from 'node:fs/promises';
import { clone as defaultClone, defaultExec } from '@linktogo/maggie-git';
import { EDITORS, launchCommand } from './platform.js';
import { planInstall } from './installers.js';
import { initRepos } from './board.js';
import { agentSpec, DEFAULT_AGENT } from './agents.js';

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultRemove(p) {
  await rm(p, { recursive: true, force: true });
}

// Compact, filesystem-safe stamp like "20260621-143005" for suffixed checkouts.
export function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export async function bootstrap(config, options = {}) {
  const {
    workspaceDir,
    agent = DEFAULT_AGENT,
    editor = agent,
    repoFilter,
    worktree,
    install = true,
    dryRun = false,
    offline = false,
    clone = defaultClone,
    exec = defaultExec,
    exists = pathExists,
    remove = defaultRemove,
    onExisting,
    timestamp = formatTimestamp,
    boardPath: boardPathOption,
    installRepoHooks,
    initBoard = initRepos,
    hookCommand,
    logger = console,
  } = options;

  if (!workspaceDir) throw new Error('bootstrap requires a workspaceDir');
  if (!EDITORS.includes(editor)) {
    throw new Error(`Unknown editor "${editor}" (known: ${EDITORS.join(', ')})`);
  }
  // A worktree is only useful for an agent driven from that directory; VS Code
  // is launched on the workspace as a whole and gets no per-branch checkout.
  if (worktree && editor === 'vscode') {
    throw new Error('--worktree is not supported with --editor vscode');
  }
  const spec = agentSpec(agent);
  const installAgentHooks = installRepoHooks ?? spec.installHooks;

  const tag = dryRun ? '[dry-run] ' : '';
  const repos = repoFilter
    ? config.repos.filter((r) => r.name === repoFilter)
    : config.repos;

  if (!dryRun) await mkdir(workspaceDir, { recursive: true });

  // The board lives beside the checkouts so the viewer and the per-repo hooks
  // agree on one path; the hooks shell out to this CLI to record transitions.
  const boardPath = boardPathOption ?? path.join(workspaceDir, '.maggie', 'board.json');

  const results = [];
  const workDirs = [];
  for (const repo of repos) {
    let checkout = repo.path ? path.resolve(repo.path) : path.join(workspaceDir, repo.name);

    let status;
    if (await exists(checkout)) {
      // Existing checkout: reuse it, or (interactively) re-clone elsewhere.
      // "reinstall" reuses a fixed "-reinstall" dir (overwritten each time);
      // "timestamp" clones into a fresh, uniquely stamped dir.
      const action = onExisting ? await onExisting(repo) : 'reuse';
      if (action === 'reuse') {
        logger.log(`${tag}= ${repo.name}: reusing existing checkout`);
        status = 'reused';
      } else {
        const baseDir = path.dirname(checkout);
        const suffix = action === 'reinstall' ? 'reinstall' : timestamp();
        checkout = path.join(baseDir, `${repo.name}-${suffix}`);
        if (action === 'reinstall' && (await exists(checkout))) {
          if (!dryRun) await remove(checkout);
          logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would remove' : 'removed'} previous ${path.basename(checkout)}`);
        }
        if (!dryRun) await clone(repo.url, checkout);
        logger.log(`${tag}✓ ${repo.name}: ${dryRun ? 'would clone' : 'cloned'} into ${path.basename(checkout)}`);
        status = 'cloned';
      }
    } else {
      if (!dryRun) await clone(repo.url, checkout);
      logger.log(`${tag}✓ ${repo.name}: ${dryRun ? 'would clone' : 'cloned'}`);
      status = 'cloned';
    }

    let workDir = checkout;
    if (worktree) {
      const wt = path.join(path.dirname(checkout), `${repo.name}.${worktree.replace(/\//g, '-')}`);
      if (await exists(wt)) {
        logger.log(`  ${tag}${repo.name}: reusing worktree ${path.basename(wt)}`);
      } else {
        if (!dryRun) await exec('git', ['-C', checkout, 'worktree', 'add', wt, '-b', worktree], {});
        logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would add' : 'added'} worktree ${path.basename(wt)} (${worktree})`);
      }
      workDir = wt;
    }
    workDirs.push(workDir);

    if (!dryRun) await installAgentHooks(workDir, repo.name, boardPath, { command: hookCommand, worktree });

    let installed = false;
    if (install) {
      const plan = await planInstall(workDir, { exists, offline });
      if (plan) {
        if (!dryRun) await exec(plan.command, plan.args, { cwd: workDir });
        logger.log(`  ${tag}${repo.name}: ${dryRun ? 'would' : 'ran'} ${plan.label} install${offline ? ' (offline)' : ''}`);
        installed = true;
      }
    }

    results.push({ repo: repo.name, status, installed });
  }

  if (!dryRun) await initBoard(boardPath, repos.map((r) => r.name));

  // Launch at the project directory itself when a single repo is targeted
  // (selected, --repo, or a single worktree); otherwise at the workspace root.
  const launchDir = workDirs.length === 1 ? workDirs[0] : workspaceDir;
  const relativeLaunch = path.relative(process.cwd(), launchDir) || '.';
  const command = launchCommand(editor, relativeLaunch);
  logger.log(`\nWorkspace ready at ${workspaceDir}`);
  logger.log(`Status hooks wired for ${spec.label}`);
  logger.log(`Launch ${editor}:\n  ${command}`);
  if (editor !== 'vscode' && !worktree) {
    logger.log('\n→ Tip: isolate your work in a git worktree with --worktree <branch>');
  }

  return { workspaceDir, agent, editor, command, results };
}
