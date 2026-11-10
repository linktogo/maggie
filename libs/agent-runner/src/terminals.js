import { randomBytes } from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AgentError } from './errors.js';

export const TERMINAL_LIMITS = { maxTerminals: 4, graceMs: 5000, bufferBytes: 65536, maxInputBytes: 65536, maxCols: 500, maxRows: 200 };

const validSize = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;

function checkSize(cols, rows) {
  if (!validSize(cols, TERMINAL_LIMITS.maxCols) || !validSize(rows, TERMINAL_LIMITS.maxRows)) {
    throw new AgentError('invalid', `cols must be 1-${TERMINAL_LIMITS.maxCols} and rows 1-${TERMINAL_LIMITS.maxRows}`);
  }
}

/**
 * node-pty's prebuilt `spawn-helper` can reach disk without its execute bit
 * (pnpm, some npm versions), and every spawn then fails with "posix_spawnp
 * failed". Restore it where it lost it; a layout that is not there is skipped.
 */
export async function ensureSpawnHelper({
  platform = process.platform, arch = process.arch, resolve = createRequire(import.meta.url).resolve, fs = { stat, chmod },
} = {}) {
  if (platform === 'win32') return;
  const root = path.dirname(resolve('node-pty/package.json'));
  for (const dir of [path.join(root, 'prebuilds', `${platform}-${arch}`), path.join(root, 'build', 'Release')]) {
    const helper = path.join(dir, 'spawn-helper');
    try {
      const { mode } = await fs.stat(helper);
      if ((mode & 0o111) !== 0o111) await fs.chmod(helper, mode | 0o755);
    } catch { /* not this layout */ }
  }
}

async function loadNodePty() {
  const pty = await import('node-pty');
  await ensureSpawnHelper();
  return pty;
}

function defaultShell(platform, env) {
  if (platform === 'win32') return env.ComSpec ?? 'cmd.exe';
  return env.SHELL ?? '/bin/sh';
}

/**
 * Interactive shells in a repository checkout, one pty each. A terminal lives
 * as long as someone reads it: when its last reader leaves (or none ever
 * comes), it is killed after `graceMs`. Its recent output is kept so a reader
 * that arrives late, even after the shell exited, still sees the prompt or the
 * error that ended it.
 */
export function createTerminalManager({
  repos,
  loadPty = loadNodePty,
  shell,
  platform = process.platform,
  env = process.env,
  maxTerminals = TERMINAL_LIMITS.maxTerminals,
  graceMs = TERMINAL_LIMITS.graceMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  randomId = () => randomBytes(8).toString('hex'),
  log = () => {},
}) {
  const command = shell ?? defaultShell(platform, env);
  const args = platform === 'win32' ? [] : ['-l'];
  const terminals = new Map();
  let loaded;

  // node-pty is a native module: a failed load disables the console, never the server.
  function load() {
    loaded ??= loadPty().then(
      (pty) => ({ ok: true, spawn: pty.spawn }),
      (err) => ({ ok: false, reason: err.message }),
    );
    return loaded;
  }

  async function available() {
    const { ok, reason } = await load();
    return ok ? { ok } : { ok, reason };
  }

  const live = () => [...terminals.values()].filter((t) => !t.exit);

  function find(id) {
    const terminal = terminals.get(id);
    if (!terminal) throw new AgentError('not-found', `unknown terminal: ${id}`);
    return terminal;
  }

  function findLive(id) {
    const terminal = terminals.get(id);
    if (!terminal || terminal.exit) throw new AgentError('not-found', `unknown terminal: ${id}`);
    return terminal;
  }

  // An exited terminal waiting for its first reader is dropped at the same deadline.
  function arm(terminal) {
    clearTimer(terminal.timer);
    terminal.timer = setTimer(() => {
      terminal.timer = null;
      if (terminal.exit) terminals.delete(terminal.id);
      else terminal.pty.kill();
    }, graceMs);
  }

  function remember(terminal, chunk) {
    terminal.buffer.push(chunk);
    terminal.bufferSize += chunk.length;
    if (terminal.bufferSize > TERMINAL_LIMITS.bufferBytes) {
      const all = Buffer.concat(terminal.buffer);
      terminal.buffer = [all.subarray(all.length - TERMINAL_LIMITS.bufferBytes)];
      terminal.bufferSize = TERMINAL_LIMITS.bufferBytes;
    }
  }

  async function open({ repo, cwd: given, cols, rows }) {
    const pty = await load();
    if (!pty.ok) throw new AgentError('unavailable', pty.reason);
    checkSize(cols, rows);
    // A `cwd` (a thread's worktree) comes from the server, never from the client.
    const cwd = typeof given === 'string' && given !== '' ? given : repos.resolve(repo);
    if (live().length >= maxTerminals) throw new AgentError('busy', `at most ${maxTerminals} consoles can be open at once`);

    const id = `tm_${randomId()}`;
    const child = pty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env, encoding: null });
    const terminal = { id, repo, cwd, pty: child, buffer: [], bufferSize: 0, subscribers: new Set(), exit: null, timer: null };
    terminals.set(id, terminal);
    child.onData((data) => {
      if (terminal.exit) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      remember(terminal, chunk);
      for (const onEvent of terminal.subscribers) onEvent({ type: 'data', data: chunk });
    });
    child.onExit(({ exitCode, signal }) => {
      terminal.exit = { type: 'exit', code: exitCode, signal: signal || null };
      log(`[${id}] exited ${exitCode}`);
      if (terminal.subscribers.size === 0) {
        // Killed by the grace timer: nobody is left to replay the end to.
        if (!terminal.timer) terminals.delete(id);
        return;
      }
      for (const onEvent of terminal.subscribers) onEvent(terminal.exit);
      terminal.subscribers.clear();
      clearTimer(terminal.timer);
      terminals.delete(id);
    });
    arm(terminal);
    log(`[${id}] shell on ${repo}`);
    return { id, repo, cwd };
  }

  function subscribe(id, onEvent) {
    const terminal = find(id);
    clearTimer(terminal.timer);
    if (terminal.bufferSize > 0) onEvent({ type: 'data', data: Buffer.concat(terminal.buffer) });
    if (terminal.exit) {
      onEvent(terminal.exit);
      terminals.delete(id);
      return () => {};
    }
    terminal.subscribers.add(onEvent);
    return () => {
      if (!terminal.subscribers.delete(onEvent)) return;
      if (terminal.subscribers.size === 0 && !terminal.exit) arm(terminal);
    };
  }

  function write(id, data) {
    const terminal = findLive(id);
    if (typeof data !== 'string') throw new AgentError('invalid', 'data must be a string');
    if (Buffer.byteLength(data) > TERMINAL_LIMITS.maxInputBytes) throw new AgentError('too-large', 'input too large');
    terminal.pty.write(data);
  }

  function resize(id, cols, rows) {
    const terminal = findLive(id);
    checkSize(cols, rows);
    terminal.pty.resize(cols, rows);
  }

  const kill = (id) => findLive(id).pty.kill();
  const killAll = () => live().forEach((t) => t.pty.kill());
  const size = () => live().length;

  return { available, open, subscribe, write, resize, kill, killAll, size };
}
