import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Each Claude Code lifecycle event maps to an action this hook performs: a
// fresh prompt or an idle/permission wait updates the board status; a
// SessionEnd means the process behind this session is going away, so its
// entry is removed instead of transitioning a status.
export const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', action: 'status', state: 'inprogress', matcher: undefined },
  { event: 'Notification', action: 'status', state: 'question', matcher: 'permission_prompt|idle_prompt' },
  { event: 'Stop', action: 'status', state: 'question', matcher: undefined },
  { event: 'SessionEnd', action: 'session-end', matcher: undefined },
];

export function hookSettings(repo, boardPath, { command = 'maggie-workspace', worktree } = {}) {
  const hooks = {};
  const worktreeFlag = worktree ? ` --worktree ${worktree}` : '';
  for (const { event, action, state, matcher } of HOOK_EVENTS) {
    const cmd = action === 'session-end'
      ? `${command} session-end ${repo} --board ${boardPath}`
      : `${command} status ${repo} ${state} --board ${boardPath} --event ${event}${worktreeFlag}`;
    const group = { hooks: [{ type: 'command', command: cmd }] };
    if (matcher) group.matcher = matcher;
    hooks[event] = [group];
  }
  return { hooks };
}

export async function installHooks(checkoutDir, repo, boardPath, opts = {}) {
  const { read = readFile, write = writeFile, ensureDir = mkdir, command, worktree } = opts;
  const dir = path.join(checkoutDir, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let existing = {};
  try {
    existing = JSON.parse(await read(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const { hooks } = hookSettings(repo, boardPath, { command, worktree });
  const merged = { ...existing, hooks: { ...existing.hooks, ...hooks } };
  await ensureDir(dir, { recursive: true });
  await write(file, JSON.stringify(merged, null, 2) + '\n');
  return { file, merged };
}
