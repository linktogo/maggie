import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { commandFor, resolveProvider, validateModel } from './providers.js';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed-out']);
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_KILL_GRACE_MS = 5000;
export const DEFAULT_MAX_EVENTS = 2000;
export const DEFAULT_MAX_OUTPUT_CHARS = 2_000_000;
export const DEFAULT_MAX_RUNS = 100;

const view = (record) => ({
  id: record.id,
  repo: record.repo,
  provider: record.provider,
  model: record.model,
  skill: record.skill,
  status: record.status,
  startedAt: record.startedAt,
  finishedAt: record.finishedAt,
  exitCode: record.exitCode,
  error: record.error,
});

/**
 * Runs agent CLIs one at a time per repository and publishes what they print.
 * Runs live in memory only: `maxEvents` bounds the output kept per run and
 * `maxOutputChars` the retained output text and `maxRuns` the number of runs,
 * finished ones going first. A CLI still alive `killGraceMs` after SIGTERM gets SIGKILL.
 */
export function createRunManager({
  spawn = nodeSpawn,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  maxRuns = DEFAULT_MAX_RUNS,
} = {}) {
  const runs = new Map();
  let counter = 0;

  function drop(record, index) {
    const [event] = record.events.splice(index, 1);
    if (event.type !== 'status') record.chars -= event.data.text.length;
  }

  function emit(record, type, data) {
    record.seq += 1;
    const event = { seq: record.seq, type, data, at: now().toISOString() };
    record.events.push(event);
    if (type !== 'status') record.chars += data.text.length;
    if (record.events.length > maxEvents) drop(record, 0);
    // Oldest output goes first; status events and the newest event stay.
    while (record.chars > maxOutputChars) {
      const index = record.events.findIndex((kept, i) => kept.type !== 'status' && i < record.events.length - 1);
      if (index === -1) break;
      drop(record, index);
    }
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        record.listeners.delete(listener);
      }
    }
  }

  // Idempotent: a spawn failure fires both `error` and `close`, only the first counts.
  function finish(record, status, { exitCode = null, error = null } = {}) {
    if (TERMINAL.has(record.status)) return;
    clearTimeout(record.timer);
    clearTimeout(record.killTimer);
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.finishedAt = now().toISOString();
    emit(record, 'status', { status, exitCode, error });
  }

  // Shared by the `close` event and the SIGKILL fallback, when `close` never comes.
  function settle(record, code, command) {
    if (record.cancelRequested) return finish(record, 'cancelled', { exitCode: code });
    if (record.timedOut) {
      return finish(record, 'timed-out', { exitCode: code, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }
    if (code === 0) return finish(record, 'succeeded', { exitCode: 0 });
    return finish(record, 'failed', { exitCode: code, error: `\`${command}\` exited with code ${code ?? 'unknown'}` });
  }

  // Asks politely, then forces: a CLI ignoring SIGTERM must not keep the repository locked.
  function terminate(record) {
    if (record.killTimer) return;
    record.child.kill('SIGTERM');
    record.killTimer = setTimeout(() => {
      record.child.kill('SIGKILL');
      settle(record, null);
    }, killGraceMs);
    record.killTimer.unref();
  }

  function prune() {
    for (const [id, record] of runs) {
      if (runs.size <= maxRuns) return;
      if (TERMINAL.has(record.status)) runs.delete(id);
    }
  }

  function start({ repo, cwd, provider, model = null, prompt, skill = null }) {
    if (typeof repo !== 'string' || repo === '') throw new AgentError('invalid', 'repo is required');
    if (typeof cwd !== 'string' || cwd === '') throw new AgentError('invalid', 'cwd is required');
    resolveProvider({ requested: provider, fallback: undefined });
    const input = buildPrompt({ prompt, skill });
    const checkedModel = validateModel(model);
    if ([...runs.values()].some((record) => record.repo === repo && !TERMINAL.has(record.status))) {
      throw new AgentError('busy', `a run is already active on ${repo}`);
    }
    const { command, args } = commandFor(provider, checkedModel);

    counter += 1;
    const record = {
      id: `run-${counter}`,
      repo,
      provider,
      model: checkedModel,
      skill: skill ? skill.id : null,
      status: 'running',
      startedAt: now().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
      events: [],
      chars: 0,
      listeners: new Set(),
      seq: 0,
      child: null,
      timer: null,
      killTimer: null,
      cancelRequested: false,
      timedOut: false,
    };
    runs.set(record.id, record);
    prune();
    emit(record, 'status', { status: 'running', exitCode: null, error: null });

    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish(record, 'failed', { error: `Could not run \`${command}\`: ${err.message}` });
      return view(record);
    }
    record.child = child;
    record.timer = setTimeout(() => {
      record.timedOut = true;
      terminate(record);
    }, timeoutMs);
    record.timer.unref();

    // One decoder per stream: a multi-byte character can be split across chunks.
    for (const [type, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk) => {
        const text = decoder.write(chunk);
        if (text) emit(record, type, { text });
      });
    }
    child.on('error', (err) => finish(record, 'failed', { error: `Could not run \`${command}\`: ${err.message}` }));
    child.on('close', (code) => settle(record, code, command));
    // The CLI may exit before reading its prompt; the resulting EPIPE is the exit code's business.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    return view(record);
  }

  function cancel(id) {
    const record = runs.get(id);
    if (!record) throw new AgentError('not-found', `unknown run: ${id}`);
    if (TERMINAL.has(record.status)) return view(record);
    record.cancelRequested = true;
    terminate(record);
    return view(record);
  }

  function get(id) {
    const record = runs.get(id);
    return record ? view(record) : null;
  }

  const list = () => [...runs.values()].map(view).reverse();

  /** Replays the kept history, then delivers live events. Returns an unsubscribe, or null for an unknown run. */
  function subscribe(id, listener) {
    const record = runs.get(id);
    if (!record) return null;
    try {
      for (const event of [...record.events]) listener(event);
    } catch {
      return () => {};
    }
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  return { start, cancel, get, list, subscribe };
}
