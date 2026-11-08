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

function setup(storeOptions = {}) {
  let n = 0;
  const store = createThreadStore({ path: ':memory:', randomId: () => `t${++n}`, ...storeOptions });
  const { manager, calls } = harness();
  const logs = [];
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli', log: (m) => logs.push(m) });
  return { store, service, calls, logs };
}

const line = (obj) => `${JSON.stringify(obj)}\n`;
const INIT = line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
const ASSISTANT = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }] } });
const RESULT = line({ type: 'result', session_id: 'sess-1', total_cost_usd: 0.08, duration_ms: 72000, is_error: false });
const out = (call, text) => call.child.stdout.emit('data', Buffer.from(text));
const close = (call, code = 0) => call.child.emit('close', code);
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return undefined; };
const kinds = (store, id) => store.listMessages(id).map((m) => `${m.role}/${m.kind}`);

async function finished(h, prompt = 'fix') {
  const thread = h.service.start({ repo: 'api', prompt });
  out(h.calls.at(-1), INIT + ASSISTANT + RESULT);
  close(h.calls.at(-1));
  return thread;
}

test('start creates a running thread with the user message and streams agent messages into it', () => {
  const { service, store, calls } = setup();
  const thread = service.start({ repo: 'api', prompt: '  fix the bug  ' });
  assert.equal(thread.status, 'running');
  assert.equal(thread.title, 'fix the bug');
  assert.equal(calls[0].opts.cwd, '/ws/api');
  out(calls[0], INIT + ASSISTANT);
  const messages = store.listMessages(thread.id);
  assert.deepEqual(messages.map((m) => [m.role, m.kind, m.runId]), [['user', 'text', 'run-1'], ['agent', 'text', 'run-1'], ['agent', 'step', 'run-1']]);
  assert.equal(messages[0].content, 'fix the bug');
  assert.equal(messages[2].content.tool, 'Read');
});

test('start with a skill titles by skill id and records it in the user message', () => {
  const { service, store } = setup();
  const a = service.start({ repo: 'api', skill: 'nx/monorepo' });
  assert.equal(a.title, 'nx/monorepo');
  assert.equal(store.listMessages(a.id)[0].content, 'skill nx/monorepo');
  const b = service.start({ repo: 'web', skill: 'nx/monorepo', prompt: 'go', model: 'sonnet' });
  assert.equal(store.listMessages(b.id)[0].content, 'skill nx/monorepo\n\ngo');
  assert.equal(b.model, 'sonnet');
});

test('start validates the repo, provider and skill like the server did', () => {
  const { service } = setup();
  assert.equal(code(() => service.start({ prompt: 'x' })), 'invalid');
  assert.equal(code(() => service.start({ repo: 'api', prompt: 'x', provider: 'bogus' })), 'invalid');
  assert.equal(code(() => service.start({ repo: 'nope', prompt: 'x' })), 'not-found');
  assert.equal(code(() => service.start({ repo: 'api', skill: 'nx/missing' })), 'not-found');
  assert.equal(code(() => service.start({ repo: 'api' })), 'invalid');
});

test('start refuses a prompt over 32768 characters before spawning or storing anything', () => {
  const { service, store, calls } = setup();
  assert.equal(code(() => service.start({ repo: 'api', prompt: `  ${'x'.repeat(32_769)}  ` })), 'invalid');
  assert.equal(calls.length, 0);
  assert.equal(store.listThreads().length, 0);
  assert.equal(service.start({ repo: 'api', prompt: 'x'.repeat(32_768) }).status, 'running');
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
  assert.deepEqual(h.calls[1].args.slice(-2), ['--resume', 'sess-1']);
  assert.equal(h.store.listMessages(thread.id).findLast((m) => m.role === 'user').content, 'and more');
  out(h.calls[1], INIT.replace('sess-1', 'sess-2'));
  close(h.calls[1], 0);
  assert.equal(h.store.getThread(thread.id).sessionId, 'sess-1');
  assert.equal(h.store.getThread(thread.id).status, 'idle');
});

test('a first run failing before any session leaves the thread failed', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
  h.calls[0].child.stderr.emit('data', Buffer.from('  boom \n'));
  close(h.calls[0], 2);
  assert.equal(h.store.getThread(thread.id).status, 'failed');
  const messages = h.store.listMessages(thread.id);
  assert.deepEqual(messages.slice(1).map((m) => [`${m.role}/${m.kind}`, m.content]), [
    ['system/error', 'boom'],
    ['system/status', { outcome: 'failed', durationMs: null, costUsd: null, error: '`claude` exited with code 2' }],
  ]);
});

test('copilot output is stored as one agent message at the end and settles idle', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x', provider: 'copilot' });
  out(h.calls[0], 'hello ');
  out(h.calls[0], 'world');
  assert.deepEqual(kinds(h.store, thread.id), ['user/text']);
  close(h.calls[0]);
  const messages = h.store.listMessages(thread.id);
  assert.equal(messages[1].content, 'hello world');
  assert.equal(h.store.getThread(thread.id).status, 'idle');
  const quiet = h.service.start({ repo: 'web', prompt: 'x', provider: 'copilot' });
  close(h.calls[1]);
  assert.deepEqual(kinds(h.store, quiet.id), ['user/text', 'system/status']);
  assert.equal(h.store.getThread(quiet.id).status, 'failed');
});

test('a busy repo refuses a new thread without creating it', () => {
  const h = setup();
  h.service.start({ repo: 'api', prompt: 'x' });
  assert.equal(code(() => h.service.start({ repo: 'api', prompt: 'y' })), 'busy');
  assert.equal(h.store.listThreads().length, 1);
});

test('replying while another thread runs on the same repo is refused and stores nothing', async () => {
  const h = setup();
  const first = await finished(h);
  h.service.start({ repo: 'api', prompt: 'other' });
  const count = h.store.listMessages(first.id).length;
  assert.equal(code(() => h.service.reply(first.id, { prompt: 'again' })), 'busy');
  assert.equal(h.store.listMessages(first.id).length, count);
  assert.equal(h.store.getThread(first.id).status, 'idle');
});

test('reply refuses unknown, running, archived, copilot, session-less, empty, oversized and orphaned threads', async () => {
  const h = setup();
  assert.equal(code(() => h.service.reply('th_nope', { prompt: 'x' })), 'not-found');
  const running = h.service.start({ repo: 'api', prompt: 'x' });
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
  const copilot = h.service.start({ repo: 'web', prompt: 'x', provider: 'copilot' });
  out(h.calls[2], 'a');
  close(h.calls[2]);
  assert.equal(code(() => h.service.reply(copilot.id, { prompt: 'x' })), 'invalid');
  const bare = h.service.start({ repo: 'web', prompt: 'x' });
  close(h.calls[3]);
  assert.equal(code(() => h.service.reply(bare.id, { prompt: 'x' })), 'invalid');
  const gone = h.store.createThread({ repo: 'old', provider: 'claude-cli', title: 't' });
  h.store.updateThread(gone.id, { status: 'idle', sessionId: 's' });
  assert.equal(code(() => h.service.reply(gone.id, { prompt: 'x' })), 'not-found');
});

test('stop cancels the active run and the thread settles idle', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
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
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
  assert.equal(code(() => h.service.setStatus(thread.id, 'archived')), 'busy');
  assert.equal(code(() => h.service.remove(thread.id)), 'busy');
  assert.equal(code(() => h.service.setStatus(thread.id, 'running')), 'invalid');
  assert.equal(code(() => h.service.setStatus('th_nope', 'idle')), 'not-found');
  assert.equal(code(() => h.service.remove('th_nope')), 'not-found');
  out(h.calls[0], INIT);
  close(h.calls[0]);
  assert.equal(h.service.setStatus(thread.id, 'archived').status, 'archived');
  assert.equal(h.service.setStatus(thread.id, 'idle').status, 'idle');
  h.service.remove(thread.id);
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

test('subscribe delivers stored messages live and a status at the end; an idle thread gets its status at once', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
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

test('a failed store write is logged and reported at the next write', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
  const add = h.store.addMessage;
  h.store.addMessage = () => { throw new Error('disk full'); };
  out(h.calls[0], INIT + ASSISTANT);
  assert.match(h.logs[0], /disk full/);
  h.store.addMessage = add;
  out(h.calls[0], line({ type: 'assistant', message: { content: [{ type: 'text', text: 'again' }] } }));
  const messages = h.store.listMessages(thread.id);
  assert.deepEqual(messages.slice(1).map((m) => [m.kind, m.content]), [['error', 'some output could not be saved'], ['text', 'again']]);
});

test('a spawn failure settles the thread failed at once', () => {
  const store = createThreadStore();
  const manager = createRunManager({ spawn: () => { throw new Error('no cwd'); } });
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli' });
  const thread = service.start({ repo: 'api', prompt: 'x' });
  assert.equal(store.getThread(thread.id).status, 'failed');
  assert.match(store.listMessages(thread.id).at(-1).content.error, /Could not run/);
});

test('a store that keeps failing still lets the run settle', () => {
  const store = createThreadStore();
  const { manager, calls } = harness();
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli' });
  const thread = service.start({ repo: 'api', prompt: 'x' });
  store.listMessages = () => { throw new Error('read failed'); };
  out(calls[0], INIT);
  close(calls[0]);
  assert.equal(store.getThread(thread.id).status, 'idle');
});

test('an exception while handling a run event is logged and the run still settles', () => {
  const store = createThreadStore();
  const { manager, calls } = harness();
  let deliver;
  const subscribe = manager.subscribe;
  manager.subscribe = (id, listener) => { deliver = listener; return subscribe(id, listener); };
  const logs = [];
  const service = createThreadService({ store, manager, repos: REPOS, skillsDir, defaultProvider: 'claude-cli', log: (m) => logs.push(m) });
  const thread = service.start({ repo: 'api', prompt: 'x' });
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

test('subscribe with after replays the stored messages after that id, then goes live', () => {
  const h = setup();
  const thread = h.service.start({ repo: 'api', prompt: 'x' });
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

test('projects lists every allowlisted repo, with zeros when it has no thread', () => {
  const h = setup();
  h.service.start({ repo: 'api', prompt: 'x' });
  const projects = h.service.projects();
  assert.deepEqual(projects.map((p) => p.repo), ['api', 'web', 'idle-repo']);
  assert.deepEqual([projects[0].threads, projects[0].running], [1, 1]);
  assert.equal(typeof projects[0].lastActivity, 'string');
  assert.deepEqual(projects[2], { repo: 'idle-repo', threads: 0, running: 0, lastActivity: null });
});
