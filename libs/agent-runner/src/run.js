import { spawn as nodeSpawn } from 'node:child_process';
import { AgentError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { commandFor, validateModel } from './providers.js';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed-out']);
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_EVENTS = 2000;
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
 * `maxRuns` the number of runs, finished ones going first.
 */
export function createRunManager({
  spawn = nodeSpawn,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
  maxRuns = DEFAULT_MAX_RUNS,
} = {}) {
  const runs = new Map();
  let counter = 0;

  function emit(record, type, data) {
    record.seq += 1;
    const event = { seq: record.seq, type, data, at: now().toISOString() };
    record.events.push(event);
    if (record.events.length > maxEvents) record.events.shift();
    for (const listener of [...record.listeners]) listener(event);
  }

  // Idempotent: a spawn failure fires both `error` and `close`, only the first counts.
  function finish(record, status, { exitCode = null, error = null } = {}) {
    if (TERMINAL.has(record.status)) return;
    clearTimeout(record.timer);
    record.status = status;
    record.exitCode = exitCode;
    record.error = error;
    record.finishedAt = now().toISOString();
    emit(record, 'status', { status, exitCode, error });
  }

  function prune() {
    for (const [id, record] of runs) {
      if (runs.size <= maxRuns) return;
      if (TERMINAL.has(record.status)) runs.delete(id);
    }
  }

  function start({ repo, cwd, provider, model = null, prompt, skill = null }) {
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
      listeners: new Set(),
      seq: 0,
      child: null,
      timer: null,
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
      child.kill('SIGTERM');
    }, timeoutMs);
    record.timer.unref();

    child.stdout.on('data', (chunk) => emit(record, 'stdout', { text: String(chunk) }));
    child.stderr.on('data', (chunk) => emit(record, 'stderr', { text: String(chunk) }));
    child.on('error', (err) => finish(record, 'failed', { error: `Could not run \`${command}\`: ${err.message}` }));
    child.on('close', (code) => {
      if (record.cancelRequested) return finish(record, 'cancelled', { exitCode: code });
      if (record.timedOut) {
        return finish(record, 'timed-out', { exitCode: code, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }
      if (code === 0) return finish(record, 'succeeded', { exitCode: 0 });
      return finish(record, 'failed', { exitCode: code, error: `\`${command}\` exited with code ${code ?? 'unknown'}` });
    });
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
    record.child.kill('SIGTERM');
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
    for (const event of [...record.events]) listener(event);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  return { start, cancel, get, list, subscribe };
}
