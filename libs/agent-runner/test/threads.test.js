import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError } from '../src/errors.js';
import { createRunManager } from '../src/run.js';
import { createThreadStore } from '../src/store.js';
import { createThreadService } from '../src/threads.js';
import { harness } from './helpers.js';

let skillsDir;
before(async () => {
  skillsDir = await mkdtemp(path.join(tmpdir(), 'threads-skills-'));
  await mkdir(path.join(skillsDir, 'nx', 'monorepo'), { recursive: true });
  await writeFile(path.join(skillsDir, 'nx', 'monorepo', 'SKILL.md'), '---\nname: nx\ndescription: d\n---\n\nUse affected.\n');
});
after(() => rm(skillsDir, { recursive: true, force: true }));

const REPOS = {
  resolve(name) {
    if (!['api', 'web'].includes(name)) throw new AgentError('not-found', `unknown repo ${name}`);
    return `/ws/${name}`;
  },
  names: () => ['api', 'web', 'idle-repo'],
};

/** In-memory stand-in for the worktree manager; `overrides` replace single methods. */
function fakeWorktrees(overrides = {}) {
  const calls = { create: [], status: [], remove: [] };
  return {
    calls,
    async create(args) {
      calls.create.push(args);
      return { path: `/ws/.worktrees/${args.repo}/${args.threadId}`, branch: `factory/${args.threadId}-x`, base: 'origin/main' };
    },
    async status(args) {
      calls.status.push(args);
      return { exists: true, dirty: false, ahead: 2 };
    },
    async remove(args) {
      calls.remove.push(args);
      return { branchKept: false };
    },
    ...overrides,
  };
}

function setup(storeOptions = {}, { worktrees, runner, exists = () => true, onWorktreeCreated } = {}) {
  let n = 0;
  const store = createThreadStore({ path: ':memory:', randomId: () => String(++n).padStart(16, '0'), ...storeOptions });
  const { manager, calls } = harness(runner);
  const logs = [];
  const service = createThreadService({
    store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli', worktrees, log: (m) => logs.push(m), exists, onWorktreeCreated,
  });
  return { store, service, calls, logs, worktrees };
}

const line = (obj) => `${JSON.stringify(obj)}\n`;
const INIT = line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
const ASSISTANT = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }] } });
const RESULT = line({ type: 'result', session_id: 'sess-1', total_cost_usd: 0.08, duration_ms: 72000, is_error: false });
const out = (call, text) => call.child.stdout.emit('data', Buffer.from(text));
const close = (call, code = 0) => call.child.emit('close', code);
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return undefined; };
const acode = async (fn) => { try { await fn(); } catch (err) { return err.code; } return undefined; };
const kinds = (store, id) => store.listMessages(id).map((m) => `${m.role}/${m.kind}`);

async function finished(h, prompt = 'fix') {
  const thread = await h.service.start({ repo: 'api', prompt });
  out(h.calls.at(-1), INIT + ASSISTANT + RESULT);
  close(h.calls.at(-1));
  return thread;
}

/** A thread started in its own worktree and finished with a resumable session. */
async function inWorktree(h, body = {}) {
  const thread = await h.service.start({ repo: 'api', prompt: 'fix', worktree: true, ...body });
  out(h.calls.at(-1), INIT + RESULT);
  close(h.calls.at(-1));
  return thread;
}

test('start creates a running thread with the user message and streams agent messages into it', async () => {
  const { service, store, calls } = setup();
  const thread = await service.start({ repo: 'api', prompt: '  fix the bug  ' });
  assert.equal(thread.status, 'running');
  assert.equal(thread.title, 'fix the bug');
  assert.equal(calls[0].opts.cwd, '/ws/api');
  out(calls[0], INIT + ASSISTANT);
  const messages = store.listMessages(thread.id);
  assert.deepEqual(messages.map((m) => [m.role, m.kind, m.runId]), [['user', 'text', 'run-1'], ['agent', 'text', 'run-1'], ['agent', 'step', 'run-1']]);
  assert.equal(messages[0].content, 'fix the bug');
  assert.equal(messages[2].content.tool, 'Read');
});

test('start with a skill titles by skill id and records it in the user message', async () => {
  const { service, store } = setup();
  const a = await service.start({ repo: 'api', skill: 'nx/monorepo' });
  assert.equal(a.title, 'nx/monorepo');
  assert.equal(store.listMessages(a.id)[0].content, 'skill nx/monorepo');
  const b = await service.start({ repo: 'web', skill: 'nx/monorepo', prompt: 'go', model: 'sonnet' });
  assert.equal(store.listMessages(b.id)[0].content, 'skill nx/monorepo\n\ngo');
  assert.equal(b.model, 'sonnet');
});

test('start validates the repo, provider and skill like the server did', async () => {
  const { service } = setup();
  assert.equal(await acode(() => service.start({ prompt: 'x' })), 'invalid');
  assert.equal(await acode(() => service.start(null)), 'invalid');
  assert.equal(await acode(() => service.start({ repo: 'api', prompt: 'x', provider: 'bogus' })), 'invalid');
  assert.equal(await acode(() => service.start({ repo: 'nope', prompt: 'x' })), 'not-found');
  assert.equal(await acode(() => service.start({ repo: 'api', skill: 'nx/missing' })), 'not-found');
  assert.equal(await acode(() => service.start({ repo: 'api' })), 'invalid');
});

test('start refuses a prompt over 32768 characters before spawning or storing anything', async () => {
  const { service, store, calls } = setup();
  assert.equal(await acode(() => service.start({ repo: 'api', prompt: `  ${'x'.repeat(32_769)}  ` })), 'invalid');
  assert.equal(calls.length, 0);
  assert.equal(store.listThreads().length, 0);
  assert.equal((await service.start({ repo: 'api', prompt: 'x'.repeat(32_768) })).status, 'running');
});

test('the session id from init is saved and the thread goes idle on success', async () => {
  const h = setup();
  const thread = await finished(h);
  const after = h.store.getThread(thread.id);
  assert.equal(after.status, 'idle');
  assert.equal(after.sessionId, 'sess-1');
  const last = h.store.listMessages(thread.id).at(-1);
  assert.equal(`${last.role}/${last.kind}`, 'system/status');
  assert.deepEqual(last.content, { outcome: 'succeeded', durationMs: 72000, costUsd: 0.08, error: null });
});

test('reply resumes the claude session', async () => {
  const h = setup();
  const thread = await finished(h);
  const replied = h.service.reply(thread.id, { prompt: 'and more' });
  assert.equal(replied.status, 'running');
  assert.equal(h.calls[1].opts.cwd, '/ws/api');
  assert.deepEqual(h.calls[1].args.slice(-2), ['--resume', 'sess-1']);
  assert.equal(h.store.listMessages(thread.id).findLast((m) => m.role === 'user').content, 'and more');
  out(h.calls[1], INIT.replace('sess-1', 'sess-2'));
  close(h.calls[1], 0);
  assert.equal(h.store.getThread(thread.id).sessionId, 'sess-1');
  assert.equal(h.store.getThread(thread.id).status, 'idle');
});

test('a first run failing before any session leaves the thread failed', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  h.calls[0].child.stderr.emit('data', Buffer.from('  boom \n'));
  close(h.calls[0], 2);
  assert.equal(h.store.getThread(thread.id).status, 'failed');
  const messages = h.store.listMessages(thread.id);
  assert.deepEqual(messages.slice(1).map((m) => [`${m.role}/${m.kind}`, m.content]), [
    ['system/error', 'boom'],
    ['system/status', { outcome: 'failed', durationMs: null, costUsd: null, error: '`claude` exited with code 2' }],
  ]);
});

test('copilot output is stored as one agent message at the end and settles idle', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x', provider: 'copilot' });
  out(h.calls[0], 'hello ');
  out(h.calls[0], 'world');
  assert.deepEqual(kinds(h.store, thread.id), ['user/text']);
  close(h.calls[0]);
  const messages = h.store.listMessages(thread.id);
  assert.equal(messages[1].content, 'hello world');
  assert.equal(h.store.getThread(thread.id).status, 'idle');
  const quiet = await h.service.start({ repo: 'web', prompt: 'x', provider: 'copilot' });
  close(h.calls[1]);
  assert.deepEqual(kinds(h.store, quiet.id), ['user/text', 'system/status']);
  assert.equal(h.store.getThread(quiet.id).status, 'failed');
});

test('a busy repo refuses a new thread without creating it', async () => {
  const h = setup();
  await h.service.start({ repo: 'api', prompt: 'x' });
  assert.equal(await acode(() => h.service.start({ repo: 'api', prompt: 'y' })), 'busy');
  assert.equal(h.store.listThreads().length, 1);
});

test('replying while another thread runs on the same repo is refused and stores nothing', async () => {
  const h = setup();
  const first = await finished(h);
  await h.service.start({ repo: 'api', prompt: 'other' });
  const count = h.store.listMessages(first.id).length;
  assert.equal(code(() => h.service.reply(first.id, { prompt: 'again' })), 'busy');
  assert.equal(h.store.listMessages(first.id).length, count);
  assert.equal(h.store.getThread(first.id).status, 'idle');
});

test('reply refuses unknown, running, archived, copilot, session-less, empty, oversized and orphaned threads', async () => {
  const h = setup();
  assert.equal(code(() => h.service.reply('th_nope', { prompt: 'x' })), 'not-found');
  const running = await h.service.start({ repo: 'api', prompt: 'x' });
  assert.equal(code(() => h.service.reply(running.id, { prompt: 'x' })), 'busy');
  out(h.calls[0], INIT + RESULT);
  close(h.calls[0]);
  assert.equal(code(() => h.service.reply(running.id, { prompt: '' })), 'invalid');
  assert.equal(code(() => h.service.reply(running.id, { prompt: 'x'.repeat(32_769) })), 'invalid');
  assert.equal(code(() => h.service.reply(running.id, {})), 'invalid');
  assert.equal(h.service.reply(running.id, { prompt: 'x'.repeat(32_768) }).status, 'running');
  close(h.calls[1]);
  h.service.setStatus(running.id, 'archived');
  assert.equal(code(() => h.service.reply(running.id, { prompt: 'x' })), 'invalid');
  const copilot = await h.service.start({ repo: 'web', prompt: 'x', provider: 'copilot' });
  out(h.calls[2], 'a');
  close(h.calls[2]);
  assert.equal(code(() => h.service.reply(copilot.id, { prompt: 'x' })), 'invalid');
  const bare = await h.service.start({ repo: 'web', prompt: 'x' });
  close(h.calls[3]);
  assert.equal(code(() => h.service.reply(bare.id, { prompt: 'x' })), 'invalid');
  const gone = h.store.createThread({ repo: 'old', provider: 'claude-cli', title: 't' });
  h.store.updateThread(gone.id, { status: 'idle', sessionId: 's' });
  assert.equal(code(() => h.service.reply(gone.id, { prompt: 'x' })), 'not-found');
});

test('stop cancels the active run and the thread settles idle', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  out(h.calls[0], INIT);
  assert.equal(h.service.stop(thread.id).id, thread.id);
  assert.equal(h.calls[0].child.killed, 'SIGTERM');
  close(h.calls[0], null);
  assert.equal(h.store.getThread(thread.id).status, 'idle');
  assert.equal(h.store.listMessages(thread.id).at(-1).content.outcome, 'cancelled');
  assert.equal(code(() => h.service.stop(thread.id)), 'not-found');
  assert.equal(code(() => h.service.stop('th_nope')), 'not-found');
});

test('archiving or deleting a running thread is refused', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  assert.equal(code(() => h.service.setStatus(thread.id, 'archived')), 'busy');
  assert.equal(await acode(() => h.service.remove(thread.id)), 'busy');
  assert.equal(code(() => h.service.setStatus(thread.id, 'running')), 'invalid');
  assert.equal(code(() => h.service.setStatus('th_nope', 'idle')), 'not-found');
  assert.equal(await acode(() => h.service.remove('th_nope')), 'not-found');
  out(h.calls[0], INIT);
  close(h.calls[0]);
  assert.equal(h.service.setStatus(thread.id, 'archived').status, 'archived');
  assert.equal(h.service.setStatus(thread.id, 'idle').status, 'idle');
  await h.service.remove(thread.id);
  assert.equal(h.service.get(thread.id), null);
});

test('get returns the thread with its messages and list filters through the store', async () => {
  const h = setup();
  const thread = await finished(h);
  const got = h.service.get(thread.id);
  assert.equal(got.thread.id, thread.id);
  assert.equal(got.messages.length, 4);
  assert.deepEqual(h.service.list({ repo: 'api' }).map((t) => t.id), [thread.id]);
});

test('subscribe delivers stored messages live and a status at the end; an idle thread gets its status at once', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  const events = [];
  const stop = h.service.subscribe(thread.id, (e) => events.push(e));
  h.service.subscribe(thread.id, () => { throw new Error('bad listener'); });
  out(h.calls[0], INIT + ASSISTANT);
  close(h.calls[0]);
  assert.deepEqual(events.map((e) => e.type), ['message', 'message', 'message', 'status']);
  assert.equal(events[0].message.kind, 'text');
  assert.equal(events[2].message.kind, 'status');
  assert.equal(events[3].status, 'idle');
  stop();
  const late = [];
  const none = h.service.subscribe(thread.id, (e) => late.push(e));
  none();
  assert.deepEqual(late, [{ type: 'status', status: 'idle' }]);
  assert.equal(h.service.subscribe('th_nope', () => {}), null);
});

test('a failed store write is logged and reported at the next write', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  const add = h.store.addMessage;
  h.store.addMessage = () => { throw new Error('disk full'); };
  out(h.calls[0], INIT + ASSISTANT);
  assert.match(h.logs[0], /disk full/);
  h.store.addMessage = add;
  out(h.calls[0], line({ type: 'assistant', message: { content: [{ type: 'text', text: 'again' }] } }));
  const messages = h.store.listMessages(thread.id);
  assert.deepEqual(messages.slice(1).map((m) => [m.kind, m.content]), [['error', 'some output could not be saved'], ['text', 'again']]);
});

test('a spawn failure settles the thread failed at once', async () => {
  const store = createThreadStore();
  const manager = createRunManager({ spawn: () => { throw new Error('no cwd'); } });
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli' });
  const thread = await service.start({ repo: 'api', prompt: 'x' });
  assert.equal(store.getThread(thread.id).status, 'failed');
  assert.match(store.listMessages(thread.id).at(-1).content.error, /Could not run/);
});

test('a store that keeps failing still lets the run settle', async () => {
  const store = createThreadStore();
  const { manager, calls } = harness();
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli' });
  const thread = await service.start({ repo: 'api', prompt: 'x' });
  store.listMessages = () => { throw new Error('read failed'); };
  out(calls[0], INIT);
  close(calls[0]);
  assert.equal(store.getThread(thread.id).status, 'idle');
});

test('an exception while handling a run event is logged and the run still settles', async () => {
  const store = createThreadStore();
  const { manager, calls } = harness();
  let deliver;
  const subscribe = manager.subscribe;
  manager.subscribe = (id, listener) => { deliver = listener; return subscribe(id, listener); };
  const logs = [];
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli', log: (m) => logs.push(m) });
  const thread = await service.start({ repo: 'api', prompt: 'x' });
  // An event the subscriber cannot handle must not make the run manager drop it.
  assert.doesNotThrow(() => deliver({ type: 'mystery' }));
  assert.match(logs[0], /run event failed/);
  out(calls[0], INIT + ASSISTANT);
  close(calls[0]);
  assert.equal(store.getThread(thread.id).status, 'idle');
  assert.equal(store.listMessages(thread.id).at(-1).content.outcome, 'succeeded');
});

test('reply with a null body is a 400-class refusal, not a TypeError', async () => {
  const h = setup();
  const thread = await finished(h);
  assert.equal(code(() => h.service.reply(thread.id, null)), 'invalid');
});

test('subscribe with after replays the stored messages after that id, then goes live', async () => {
  const h = setup();
  const thread = await h.service.start({ repo: 'api', prompt: 'x' });
  out(h.calls[0], INIT + ASSISTANT);
  const [first] = h.store.listMessages(thread.id);
  const events = [];
  h.service.subscribe(thread.id, (e) => events.push(e), { after: first.id });
  assert.deepEqual(events.map((e) => e.message.kind), ['text', 'step']);
  close(h.calls[0]);
  assert.deepEqual(events.slice(2).map((e) => e.type), ['message', 'status']);
  // An idle thread replays its backlog, then its status.
  const idle = [];
  h.service.subscribe(thread.id, (e) => idle.push(e), { after: 0 });
  assert.deepEqual(idle.map((e) => e.type), ['message', 'message', 'message', 'message', 'status']);
  assert.equal(idle.at(-1).status, 'idle');
});

test('projects lists every allowlisted repo, with zeros when it has no thread', async () => {
  const h = setup();
  await h.service.start({ repo: 'api', prompt: 'x' });
  const projects = h.service.projects();
  assert.deepEqual(projects.map((p) => p.repo), ['api', 'web', 'idle-repo']);
  assert.deepEqual([projects[0].threads, projects[0].running], [1, 1]);
  assert.equal(typeof projects[0].lastActivity, 'string');
  assert.deepEqual(projects[2], { repo: 'idle-repo', threads: 0, running: 0, lastActivity: null });
});

// ---- worktrees

test('start with worktree: true creates the worktree for the thread id and runs the agent in it', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const thread = await h.service.start({ repo: 'api', prompt: '  fix the bug  ', worktree: true });
  assert.deepEqual(h.worktrees.calls.create, [{ repo: 'api', repoDir: '/ws/api', threadId: thread.id, title: 'fix the bug' }]);
  assert.equal(h.calls[0].opts.cwd, `/ws/.worktrees/api/${thread.id}`);
  assert.deepEqual(thread.worktree, { path: `/ws/.worktrees/api/${thread.id}`, branch: `factory/${thread.id}-x`, base: 'origin/main' });
  assert.equal(thread.status, 'running');
  assert.equal(h.service.cwdOf(thread.id), `/ws/.worktrees/api/${thread.id}`);
});

test('start with a skill and no prompt titles the worktree by skill id; accented titles pass through untouched', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  await h.service.start({ repo: 'api', skill: 'nx/monorepo', worktree: true });
  assert.equal(h.worktrees.calls.create[0].title, 'nx/monorepo');
  await h.service.start({ repo: 'web', prompt: 'Réparer le café ☕', worktree: true });
  assert.equal(h.worktrees.calls.create[1].title, 'Réparer le café ☕');
});

test('start without worktree (or with false) never touches the worktree manager and runs in the checkout', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const a = await h.service.start({ repo: 'api', prompt: 'x' });
  const b = await h.service.start({ repo: 'web', prompt: 'x', worktree: false });
  assert.deepEqual(h.worktrees.calls.create, []);
  assert.deepEqual(h.calls.map((c) => c.opts.cwd), ['/ws/api', '/ws/web']);
  assert.equal(a.worktree, null);
  assert.equal(b.worktree, null);
  assert.equal(h.service.cwdOf(a.id), '/ws/api');
  assert.equal(code(() => h.service.cwdOf('th_nope')), 'not-found');
});

test('start refuses worktree values that are not booleans, and worktree: true when worktrees are unavailable', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  assert.equal(await acode(() => h.service.start({ repo: 'api', prompt: 'x', worktree: 'yes' })), 'invalid');
  assert.equal(await acode(() => h.service.start({ repo: 'api', prompt: 'x', worktree: null })), 'invalid');
  assert.deepEqual(h.worktrees.calls.create, []);
  const bare = setup();
  const err = await bare.service.start({ repo: 'api', prompt: 'x', worktree: true }).catch((e) => e);
  assert.equal(err.code, 'invalid');
  assert.equal(err.message, 'worktrees are not available');
  assert.equal(bare.calls.length, 0);
  assert.equal((await bare.service.start({ repo: 'api', prompt: 'x', worktree: false })).status, 'running');
});

test('invalid input never creates a worktree', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  for (const [body, expected] of [
    [{ prompt: 'x', worktree: true }, 'invalid'],
    [{ repo: 'nope', prompt: 'x', worktree: true }, 'not-found'],
    [{ repo: 'api', prompt: 'x', provider: 'bogus', worktree: true }, 'invalid'],
    [{ repo: 'api', skill: 'nx/missing', worktree: true }, 'not-found'],
    [{ repo: 'api', prompt: 'x'.repeat(32_769), worktree: true }, 'invalid'],
    [{ repo: 'api', worktree: true }, 'invalid'],
    [{ repo: 'api', prompt: 42, worktree: true }, 'invalid'],
    [{ repo: 'api', prompt: 'x', model: '--bad', worktree: true }, 'invalid'],
  ]) {
    assert.equal(await acode(() => h.service.start(body)), expected);
  }
  assert.deepEqual(h.worktrees.calls.create, []);
  assert.equal(h.calls.length, 0);
});

test('a worktree that cannot be created surfaces the error and leaves no thread', async () => {
  const worktrees = fakeWorktrees({ create: async () => { throw new AgentError('git', 'fetch failed'); } });
  const h = setup({}, { worktrees });
  assert.equal(await acode(() => h.service.start({ repo: 'api', prompt: 'x', worktree: true })), 'git');
  assert.equal(h.store.listThreads().length, 0);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(worktrees.calls.remove, []);
});

test('a run refused after the worktree exists (cap reached) removes it with force and leaves no thread', async () => {
  const h = setup({}, { worktrees: fakeWorktrees(), runner: { maxActive: 1 } });
  await h.service.start({ repo: 'web', prompt: 'busy elsewhere' });
  const err = await h.service.start({ repo: 'api', prompt: 'x', worktree: true }).catch((e) => e);
  assert.equal(err.code, 'busy');
  assert.match(err.message, /too many agents/);
  const [created] = h.worktrees.calls.create;
  assert.deepEqual(h.worktrees.calls.remove, [{ repoDir: '/ws/api', path: `/ws/.worktrees/api/${created.threadId}`, branch: `factory/${created.threadId}-x`, base: 'origin/main', force: true }]);
  assert.deepEqual(h.store.listThreads().map((t) => t.repo), ['web']);
  assert.equal(h.store.getThread(created.threadId), null);
});

test('a failing cleanup is logged and the original error is the one rethrown', async () => {
  const worktrees = fakeWorktrees({ remove: async () => { throw new AgentError('git', 'cannot remove'); } });
  const h = setup({}, { worktrees, runner: { maxActive: 1 } });
  await h.service.start({ repo: 'web', prompt: 'busy elsewhere' });
  const err = await h.service.start({ repo: 'api', prompt: 'x', worktree: true }).catch((e) => e);
  assert.equal(err.code, 'busy');
  assert.match(h.logs.at(-1), /worktree cleanup failed: cannot remove/);
  assert.equal(h.store.listThreads().length, 1);
});

test('reply runs in the worktree; once the worktree was removed the session is gone and the thread cannot be resumed', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const thread = await inWorktree(h);
  const dir = `/ws/.worktrees/api/${thread.id}`;
  h.service.reply(thread.id, { prompt: 'more' });
  assert.equal(h.calls[1].opts.cwd, dir);
  close(h.calls[1]);
  assert.equal(h.store.getThread(thread.id).sessionId, 'sess-1');
  const removed = await h.service.removeWorktree(thread.id);
  assert.equal(removed.thread.worktree, null);
  assert.equal(removed.thread.sessionId, null);
  const err = (() => { try { h.service.reply(thread.id, { prompt: 'again' }); } catch (e) { return e; } return null; })();
  assert.equal(err.code, 'invalid');
  assert.equal(err.message, 'this thread cannot be resumed');
  assert.equal(h.calls.length, 2);
  // the console still opens, in the main checkout
  assert.equal(h.service.cwdOf(thread.id), '/ws/api');
});

test('a stored worktree deleted from disk is refused for reply and console, never swapped for the checkout', async () => {
  let present = true;
  const seen = [];
  const h = setup({}, { worktrees: fakeWorktrees(), exists: (p) => { seen.push(p); return present; } });
  const thread = await inWorktree(h);
  present = false;
  const message = 'the worktree of this thread was deleted; remove it from the thread, then restart the request';
  for (const fn of [() => h.service.reply(thread.id, { prompt: 'again' }), () => h.service.cwdOf(thread.id)]) {
    const err = (() => { try { fn(); } catch (e) { return e; } return null; })();
    assert.equal(err.code, 'invalid');
    assert.equal(err.message, message);
  }
  assert.equal(h.calls.length, 1);
  assert.ok(seen.every((p) => p === thread.worktree.path));
  assert.ok(h.service.get(thread.id).messages.every((m) => m.content !== 'again'));
});

test('the real existsSync is the default: a fake worktree path is reported deleted', async () => {
  const store = createThreadStore({ path: ':memory:' });
  const { manager } = harness();
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli', worktrees: fakeWorktrees() });
  const thread = await service.start({ repo: 'api', prompt: 'x', worktree: true });
  assert.equal(code(() => service.cwdOf(thread.id)), 'invalid');
});

test('onWorktreeCreated runs after create and before the run; a failure is logged, not fatal', async () => {
  const order = [];
  const worktrees = fakeWorktrees({ create: async (args) => { order.push('create'); return { path: `/ws/.worktrees/api/${args.threadId}`, branch: 'b', base: 'origin/main' }; } });
  const hooked = [];
  const h = setup({}, {
    worktrees,
    onWorktreeCreated: async (p) => {
      order.push('hook');
      hooked.push(p);
      assert.equal(h.calls.length, 0);
    },
  });
  const thread = await h.service.start({ repo: 'api', prompt: 'x', worktree: true });
  assert.deepEqual(order, ['create', 'hook']);
  assert.deepEqual(hooked, [thread.worktree.path]);
  assert.equal(h.calls.length, 1);
  // not called without a worktree
  await h.service.start({ repo: 'web', prompt: 'x' });
  assert.equal(hooked.length, 1);

  const failing = setup({}, { worktrees: fakeWorktrees(), onWorktreeCreated: async () => { throw new Error('no state file'); } });
  const started = await failing.service.start({ repo: 'api', prompt: 'x', worktree: true });
  assert.equal(started.status, 'running');
  assert.match(failing.logs.at(-1), new RegExp(`thread ${started.id}: worktree hook failed: no state file`));
});

test('describe merges the live worktree state; get stays unchanged', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const thread = await inWorktree(h);
  const { path: wtPath, base } = thread.worktree;
  const described = await h.service.describe(thread.id);
  assert.deepEqual(described.thread.worktree, { ...thread.worktree, exists: true, dirty: false, ahead: 2 });
  assert.deepEqual(h.worktrees.calls.status, [{ path: wtPath, base }]);
  assert.equal(described.messages.length, h.service.get(thread.id).messages.length);
  assert.deepEqual(h.service.get(thread.id).thread.worktree, thread.worktree);
});

test('describe reports an unknown state when the status cannot be read, and handles threads without a worktree', async () => {
  const worktrees = fakeWorktrees({ status: async () => { throw new AgentError('git', 'boom'); } });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  const described = await h.service.describe(thread.id);
  assert.deepEqual(described.thread.worktree, { ...thread.worktree, exists: true, dirty: null, ahead: null });
  assert.match(h.logs.at(-1), /worktree status failed: boom/);
  const plain = await h.service.start({ repo: 'web', prompt: 'x' });
  assert.deepEqual(await h.service.describe(plain.id), h.service.get(plain.id));
  assert.equal(await h.service.describe('th_nope'), null);
});

test('removeWorktree refuses unknown, running and worktree-less threads', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  assert.equal(await acode(() => h.service.removeWorktree('th_nope')), 'not-found');
  const running = await h.service.start({ repo: 'api', prompt: 'x', worktree: true });
  assert.equal(await acode(() => h.service.removeWorktree(running.id)), 'busy');
  assert.deepEqual(h.worktrees.calls.remove, []);
  const plain = await h.service.start({ repo: 'web', prompt: 'x' });
  close(h.calls[1]);
  const err = await h.service.removeWorktree(plain.id).catch((e) => e);
  assert.equal(err.code, 'not-found');
  assert.equal(err.message, 'this thread has no worktree');
});

test('removeWorktree forwards force, reports branchKept and clears the worktree in the store', async () => {
  const worktrees = fakeWorktrees({ remove: async (args) => { worktrees.calls.remove.push(args); return { branchKept: true }; } });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  const result = await h.service.removeWorktree(thread.id, { force: true });
  assert.equal(result.branchKept, true);
  assert.equal(result.thread.worktree, null);
  assert.equal(h.store.getThread(thread.id).worktree, null);
  const [call] = worktrees.calls.remove;
  assert.deepEqual(call, { repoDir: '/ws/api', ...thread.worktree, force: true });
  assert.equal(h.store.getThread(thread.id).status, 'idle');
});

test('removeWorktree propagates dirty and keeps the worktree recorded; the default is not forced', async () => {
  const worktrees = fakeWorktrees({ remove: async (args) => { worktrees.calls.remove.push(args); throw new AgentError('dirty', 'uncommitted changes'); } });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  assert.equal(await acode(() => h.service.removeWorktree(thread.id)), 'dirty');
  assert.equal(worktrees.calls.remove[0].force, false);
  assert.deepEqual(h.store.getThread(thread.id).worktree, thread.worktree);
});

test('remove keeps the thread when its worktree is dirty, and deletes both when forced', async () => {
  const worktrees = fakeWorktrees({
    remove: async (args) => {
      worktrees.calls.remove.push(args);
      if (!args.force) throw new AgentError('dirty', 'uncommitted changes');
      return { branchKept: false };
    },
  });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  assert.equal(await acode(() => h.service.remove(thread.id)), 'dirty');
  assert.notEqual(h.service.get(thread.id), null);
  await h.service.remove(thread.id, { force: true });
  assert.equal(h.service.get(thread.id), null);
  assert.deepEqual(worktrees.calls.remove.map((c) => c.force), [false, true]);
  assert.equal(worktrees.calls.remove[1].repoDir, '/ws/api');
});

test('while a worktree is being removed, reply and further removals are refused; afterwards the thread is usable again', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worktrees = fakeWorktrees({ remove: async (args) => { worktrees.calls.remove.push(args); await gate; return { branchKept: false }; } });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  const first = h.service.removeWorktree(thread.id);
  assert.equal(code(() => h.service.reply(thread.id, { prompt: 'x' })), 'busy');
  assert.equal(code(() => h.service.setStatus(thread.id, 'archived')), 'busy');
  assert.equal(await acode(() => h.service.removeWorktree(thread.id)), 'busy');
  assert.equal(await acode(() => h.service.remove(thread.id)), 'busy');
  assert.equal(worktrees.calls.remove.length, 1);
  release();
  assert.equal((await first).thread.worktree, null);
  assert.equal(h.service.setStatus(thread.id, 'archived').status, 'archived');
  assert.equal(h.calls.length, 1);
});

test('a failed removal clears the removing guard, and remove holds it too', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fail = true;
  const worktrees = fakeWorktrees({
    remove: async (args) => {
      worktrees.calls.remove.push(args);
      await gate;
      if (fail) throw new AgentError('dirty', 'uncommitted changes');
      return { branchKept: false };
    },
  });
  const h = setup({}, { worktrees });
  const thread = await inWorktree(h);
  const pending = h.service.remove(thread.id);
  assert.equal(code(() => h.service.reply(thread.id, { prompt: 'x' })), 'busy');
  release();
  assert.equal(await pending.catch((e) => e.code), 'dirty');
  fail = false;
  await h.service.remove(thread.id);
  assert.equal(h.service.get(thread.id), null);
});

test('a stored worktree cannot be removed when worktrees are unavailable', async () => {
  const h = setup();
  const thread = h.store.createThread({ repo: 'api', provider: 'claude-cli', title: 't', worktree: { path: '/ws/.worktrees/api/x', branch: 'b', base: 'origin/main' } });
  h.store.updateThread(thread.id, { status: 'idle' });
  const err = await h.service.remove(thread.id).catch((e) => e);
  assert.equal(err.code, 'invalid');
  assert.equal(err.message, 'worktrees are not available');
  assert.equal(await acode(() => h.service.removeWorktree(thread.id)), 'invalid');
  assert.notEqual(h.service.get(thread.id), null);
  assert.equal(code(() => h.service.setStatus(thread.id, 'archived')), undefined);
});

test('remove of a worktree-less thread does not call the worktree manager', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const thread = await finished(h);
  await h.service.remove(thread.id);
  assert.equal(h.service.get(thread.id), null);
  assert.deepEqual(h.worktrees.calls.remove, []);
});

test('archiving a thread never removes its worktree', async () => {
  const h = setup({}, { worktrees: fakeWorktrees() });
  const thread = await inWorktree(h);
  assert.equal(h.service.setStatus(thread.id, 'archived').status, 'archived');
  assert.deepEqual(h.worktrees.calls.remove, []);
  assert.deepEqual(h.store.getThread(thread.id).worktree, thread.worktree);
});
