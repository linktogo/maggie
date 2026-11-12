import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// GitHub Copilot CLI reads an inline `hooks` block from the repository's
// `.github/copilot/settings.local.json` — the user-specific, gitignored twin of
// `.claude/settings.local.json`, which is why the board wires itself there
// rather than into the committed `.github/hooks/*.json` files.
export const COPILOT_SETTINGS_FILE = ['.github', 'copilot', 'settings.local.json'];

// Copilot's lifecycle events, mapped onto the same board actions as the Claude
// Code hooks. Two differences drive the mapping:
//
//  - `userPromptSubmitted` command hooks have their stdout dropped, so queued
//    dashboard messages cannot ride back in on a prompt the way they do under
//    Claude Code. `sessionStart` and `notification` do honour an
//    `additionalContext` reply, so the queue is drained there instead.
//  - `notification` replaces Claude's `Notification`; its types are
//    `permission_prompt`, `elicitation_dialog` and `agent_idle` — all three mean
//    the agent is blocked on a human.
export const COPILOT_HOOK_EVENTS = [
  { event: 'sessionStart', action: 'messages', matcher: undefined },
  { event: 'userPromptSubmitted', action: 'status', state: 'inprogress', matcher: undefined },
  { event: 'notification', action: 'status', state: 'question', matcher: 'permission_prompt|elicitation_dialog|agent_idle' },
  { event: 'agentStop', action: 'status', state: 'question', matcher: undefined },
  { event: 'sessionEnd', action: 'session-end', matcher: undefined },
];

function commandFor({ action, state, event }, repo, boardPath, worktreeFlag) {
  if (action === 'session-end') return `session-end ${repo} --board ${boardPath} --agent copilot`;
  if (action === 'messages') return `messages ${repo} --board ${boardPath} --agent copilot`;
  return `status ${repo} ${state} --board ${boardPath} --event ${event} --agent copilot${worktreeFlag}`;
}

export function copilotHookSettings(repo, boardPath, { command = 'maggie-workspace', worktree } = {}) {
  const hooks = {};
  const worktreeFlag = worktree ? ` --worktree ${worktree}` : '';
  for (const def of COPILOT_HOOK_EVENTS) {
    // `command` (rather than `bash`/`powershell`) is the cross-platform field:
    // Copilot copies it to both shells, and the CLI invocation is identical.
    const entry = { type: 'command', command: `${command} ${commandFor(def, repo, boardPath, worktreeFlag)}` };
    if (def.matcher) entry.matcher = def.matcher;
    hooks[def.event] = [entry];
  }
  return { hooks };
}

// Reads a Copilot hook block back into `{ event: command }` so a caller can
// tell an up-to-date wiring from a drifted one.
export function flattenCopilotHooks(hooks) {
  const flat = {};
  for (const { event } of COPILOT_HOOK_EVENTS) {
    flat[event] = hooks?.[event]?.[0]?.command;
  }
  return flat;
}

export async function installCopilotHooks(checkoutDir, repo, boardPath, opts = {}) {
  const { read = readFile, write = writeFile, ensureDir = mkdir, command, worktree } = opts;
  const file = path.join(checkoutDir, ...COPILOT_SETTINGS_FILE);
  let existing = {};
  try {
    existing = JSON.parse(await read(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const { hooks } = copilotHookSettings(repo, boardPath, { command, worktree });
  const merged = { ...existing, hooks: { ...existing.hooks, ...hooks } };
  await ensureDir(path.dirname(file), { recursive: true });
  await write(file, JSON.stringify(merged, null, 2) + '\n');
  return { file, merged };
}
