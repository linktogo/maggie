// Message-center service: connects the run manager to the thread store through the stream parser.
import { existsSync } from 'node:fs';
import { AgentError } from './errors.js';
import { buildPrompt } from './prompt.js';
import { resolveProvider, validateModel } from './providers.js';
import { loadSkill } from './skills.js';
import { createStreamParser } from './stream.js';
import { TERMINAL } from './run.js';

export const MAX_MESSAGE_CHARS = 32_768;
const TITLE_CHARS = 80;
const LOST_NOTICE = 'some output could not be saved';

/** Threads of an organization's repositories: start, reply, stop, archive, and follow them live. */
export function createThreadService({
  store, manager, repos, skillsDir, defaultProvider, worktrees = null, log = () => {}, exists = existsSync, onWorktreeCreated = null,
}) {
  const active = new Map(); // thread id -> run id
  const listeners = new Map(); // thread id -> Set of listeners
  const lost = new Set(); // thread ids with a failed write not reported yet

  function publish(threadId, event) {
    const set = listeners.get(threadId);
    for (const listener of [...(set ?? [])]) {
      try {
        listener(event);
      } catch {
        set.delete(listener);
      }
    }
  }

  /** Run a store write; a failure is logged and never reaches the run. */
  function guard(threadId, write) {
    try {
      return write();
    } catch (err) {
      log(`thread ${threadId}: store write failed: ${err.message}`);
      lost.add(threadId);
      return undefined;
    }
  }

  function save(threadId, message) {
    guard(threadId, () => {
      if (lost.has(threadId)) {
        const notice = store.addMessage(threadId, { role: 'system', kind: 'error', content: LOST_NOTICE, runId: message.runId });
        lost.delete(threadId);
        publish(threadId, { type: 'message', message: notice });
      }
      publish(threadId, { type: 'message', message: store.addMessage(threadId, message) });
    });
  }

  function setStatus(threadId, status) {
    guard(threadId, () => store.updateThread(threadId, { status }));
    publish(threadId, { type: 'status', status });
  }

  function track(thread, run) {
    const { id } = thread;
    const parser = createStreamParser(run.provider);
    const copilot = run.provider !== 'claude-cli';
    const state = { sessionId: thread.sessionId, durationMs: null, costUsd: null, text: '', stderr: '' };
    const agent = (kind, content) => save(id, { role: 'agent', kind, content, runId: run.id });

    function handle(parsed) {
      if (parsed.kind === 'session') {
        if (!state.sessionId && parsed.sessionId) {
          state.sessionId = parsed.sessionId;
          guard(id, () => store.updateThread(id, { sessionId: parsed.sessionId }));
        }
      } else if (parsed.kind === 'result') {
        state.durationMs = parsed.durationMs;
        state.costUsd = parsed.costUsd;
      } else if (copilot) state.text += parsed.content;
      else agent(parsed.kind, parsed.content);
    }

    function settle(final) {
      parser.end().forEach(handle);
      if (state.text) agent('text', state.text);
      if (state.stderr.trim()) save(id, { role: 'system', kind: 'error', content: state.stderr.trim(), runId: run.id });
      save(id, {
        role: 'system', kind: 'status', runId: run.id,
        content: { outcome: final.status, durationMs: state.durationMs, costUsd: state.costUsd, error: final.error },
      });
      active.delete(id);
      const answered = guard(id, () => store.listMessages(id).some((m) => m.role === 'agent')) ?? false;
      setStatus(id, state.sessionId || answered ? 'idle' : 'failed');
    }

    active.set(id, run.id);
    // A listener that throws is dropped by the run manager, which would detach
    // the thread from its run forever: a bad event is logged and skipped instead.
    manager.subscribe(run.id, (event) => {
      try {
        if (event.type === 'stdout') parser.push(event.data.text).forEach(handle);
        else if (event.type === 'stderr') state.stderr += event.data.text;
        else if (TERMINAL.has(event.data.status)) settle(event.data);
      } catch (err) {
        log(`thread ${id}: run event failed: ${err.message}`);
      }
    });
  }

  function existing(id) {
    const thread = store.getThread(id);
    if (!thread) throw new AgentError('not-found', `unknown thread: ${id}`);
    return thread;
  }

  const removing = new Set(); // thread ids whose worktree or record is being deleted

  const settled = (thread) => {
    if (thread.status === 'running') throw new AgentError('busy', 'this thread is running');
    if (removing.has(thread.id)) throw new AgentError('busy', 'this thread is being removed');
    return thread;
  };

  /** Where a thread's runs live: its worktree, else the main checkout. A deleted worktree is never swapped for the checkout. */
  function cwdOf(id) {
    const thread = existing(id);
    if (!thread.worktree) return repos.resolve(thread.repo);
    if (!exists(thread.worktree.path)) {
      throw new AgentError('invalid', 'the worktree of this thread was deleted; remove it from the thread, then restart the request');
    }
    return thread.worktree.path;
  }

  function dropWorktree(thread, force) {
    if (!worktrees) throw new AgentError('invalid', 'worktrees are not available');
    const { path, branch, base } = thread.worktree;
    return worktrees.remove({ repoDir: repos.resolve(thread.repo), path, branch, base, force });
  }

  async function start(body) {
    if (typeof body?.repo !== 'string') throw new AgentError('invalid', 'repo is required');
    if (body.worktree !== undefined && typeof body.worktree !== 'boolean') throw new AgentError('invalid', 'worktree must be a boolean');
    if (body.worktree && !worktrees) throw new AgentError('invalid', 'worktrees are not available');
    const provider = resolveProvider({ requested: body.provider, fallback: defaultProvider });
    const repoDir = repos.resolve(body.repo);
    const skill = body.skill === undefined || body.skill === null ? null : loadSkill(skillsDir, body.skill);
    const task = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (task.length > MAX_MESSAGE_CHARS) throw new AgentError('invalid', `prompt is too long (max ${MAX_MESSAGE_CHARS} characters)`);
    // What the run would refuse is refused here too, before any git call.
    buildPrompt({ prompt: body.prompt, skill });
    validateModel(body.model);
    const title = task.slice(0, TITLE_CHARS) || skill.id;
    const options = { repo: body.repo, provider, model: body.model, prompt: body.prompt, skill };
    // The run starts before the thread is stored: a refused run leaves no thread behind.
    let run;
    let id;
    let worktree = null;
    if (body.worktree) {
      id = store.newThreadId();
      worktree = await worktrees.create({ repo: body.repo, repoDir, threadId: id, title });
      if (onWorktreeCreated) {
        try {
          await onWorktreeCreated(worktree.path);
        } catch (err) {
          log(`thread ${id}: worktree hook failed: ${err.message}`);
        }
      }
      try {
        run = manager.start({ ...options, cwd: worktree.path });
      } catch (err) {
        try {
          await worktrees.remove({ repoDir, path: worktree.path, branch: worktree.branch, base: worktree.base, force: true });
        } catch (cleanup) {
          log(`thread ${id}: worktree cleanup failed: ${cleanup.message}`);
        }
        throw err;
      }
    } else {
      run = manager.start({ ...options, cwd: repoDir });
    }
    const thread = store.createThread({ id, repo: body.repo, provider, model: run.model, skill: run.skill, title, worktree });
    const head = skill ? `skill ${skill.id}` : '';
    save(thread.id, { role: 'user', kind: 'text', content: head && task ? `${head}\n\n${task}` : head || task, runId: run.id });
    track(thread, run);
    return store.getThread(thread.id);
  }

  function reply(id, body) {
    const prompt = body?.prompt;
    const thread = settled(existing(id));
    if (thread.status === 'archived') throw new AgentError('invalid', 'an archived thread cannot be resumed');
    if (thread.provider !== 'claude-cli' || !thread.sessionId) throw new AgentError('invalid', 'this thread cannot be resumed');
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new AgentError('invalid', 'prompt is required');
    if (prompt.length > MAX_MESSAGE_CHARS) throw new AgentError('invalid', `prompt is too long (max ${MAX_MESSAGE_CHARS} characters)`);
    const cwd = cwdOf(id);
    const run = manager.start({ repo: thread.repo, cwd, provider: thread.provider, model: thread.model, prompt, resume: thread.sessionId });
    save(id, { role: 'user', kind: 'text', content: prompt, runId: run.id });
    store.updateThread(id, { status: 'running' });
    track(thread, run);
    return store.getThread(id);
  }

  function stop(id) {
    const thread = existing(id);
    if (!active.has(id)) throw new AgentError('not-found', 'no active run for this thread');
    manager.cancel(active.get(id));
    return thread;
  }

  return {
    start,
    reply,
    stop,

    setStatus(id, status) {
      if (status !== 'archived' && status !== 'idle') throw new AgentError('invalid', 'status must be archived or idle');
      settled(existing(id));
      return store.updateThread(id, { status });
    },

    cwdOf,

    async remove(id, { force = false } = {}) {
      const thread = settled(existing(id));
      removing.add(id);
      try {
        if (thread.worktree) await dropWorktree(thread, force);
        store.deleteThread(id);
        listeners.delete(id);
      } finally {
        removing.delete(id);
      }
    },

    async removeWorktree(id, { force = false } = {}) {
      const thread = settled(existing(id));
      if (!thread.worktree) throw new AgentError('not-found', 'this thread has no worktree');
      removing.add(id);
      try {
        const { branchKept } = await dropWorktree(thread, force);
        // Clears the session too: it cannot be resumed outside its worktree, nor in the main checkout.
        store.updateThread(id, { worktree: null });
        return { thread: store.getThread(id), branchKept };
      } finally {
        removing.delete(id);
      }
    },

    get(id) {
      const thread = store.getThread(id);
      return thread ? { thread, messages: store.listMessages(id) } : null;
    },

    /** Like `get`, with the live state of the worktree (it may be gone, dirty or ahead). */
    async describe(id) {
      const thread = store.getThread(id);
      if (!thread) return null;
      const messages = store.listMessages(id);
      if (!thread.worktree) return { thread, messages };
      const { path, base } = thread.worktree;
      let state;
      try {
        state = await worktrees.status({ path, base });
      } catch (err) {
        log(`thread ${id}: worktree status failed: ${err.message}`);
        state = { exists: true, dirty: null, ahead: null };
      }
      return { thread: { ...thread, worktree: { ...thread.worktree, ...state } }, messages };
    },

    list: (query) => store.listThreads(query),

    projects() {
      const stats = new Map(store.projectStats().map((row) => [row.repo, row]));
      return repos.names().map((repo) => {
        const row = stats.get(repo);
        return { repo, threads: row?.threads ?? 0, running: row?.running ?? 0, lastActivity: row?.lastActivity ?? null };
      });
    },

    /**
     * Follow a thread. With `after`, the stored messages past that id are replayed
     * first; the store is synchronous, so the replay and the subscription happen in
     * the same tick and no message can fall in between.
     */
    subscribe(id, listener, { after } = {}) {
      const thread = store.getThread(id);
      if (!thread) return null;
      if (after !== undefined) {
        for (const message of store.listMessages(id, { after })) listener({ type: 'message', message });
      }
      if (thread.status !== 'running') {
        listener({ type: 'status', status: thread.status });
        return () => {};
      }
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(listener);
      return () => listeners.get(id)?.delete(listener);
    },
  };
}
