import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createThreadStore } from '../src/store.js';

function fixture() {
  let tick = 0;
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const store = createThreadStore({ now, randomId: () => `id${seq++}` });
  const make = (over = {}) => store.createThread({ repo: 'api', provider: 'claude', model: null, skill: null, title: 'a title', ...over });
  return { store, make };
}

test('migrates a fresh database to version 1 and does not re-run on reopen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-store-'));
  const file = path.join(dir, 'threads.db');
  const first = createThreadStore({ path: file });
  const thread = first.createThread({ repo: 'api', provider: 'claude', title: 't' });
  first.close();
  const second = createThreadStore({ path: file });
  assert.equal(second.getThread(thread.id).title, 't');
  second.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('creates, reads and updates a thread', () => {
  const { store, make } = fixture();
  const thread = make({ model: 'opus', skill: 'review', title: 'hello' });
  assert.deepEqual(thread, {
    id: 'th_id0', repo: 'api', provider: 'claude', model: 'opus', skill: 'review', title: 'hello',
    sessionId: null, status: 'running', createdAt: thread.createdAt, updatedAt: thread.createdAt,
  });
  assert.deepEqual(store.getThread(thread.id), thread);
  assert.equal(store.getThread('nope'), null);
  const updated = store.updateThread(thread.id, { status: 'idle', sessionId: 's1' });
  assert.equal(updated.status, 'idle');
  assert.equal(updated.sessionId, 's1');
  assert.notEqual(updated.updatedAt, thread.updatedAt);
  const statusOnly = store.updateThread(thread.id, { status: 'failed' });
  assert.equal(statusOnly.sessionId, 's1');
  assert.equal(store.updateThread(thread.id, { sessionId: 's2' }).status, 'failed');
});

test('defaults model, skill and the id generator', () => {
  const store = createThreadStore();
  const thread = store.createThread({ repo: 'api', provider: 'claude', title: 't' });
  assert.match(thread.id, /^th_[0-9a-f]+$/);
  assert.equal(thread.model, null);
  assert.equal(thread.skill, null);
  store.close();
});

test('stores text and step messages, parsing content back with its type', () => {
  const { store, make } = fixture();
  const { id } = make();
  const step = { tool: 'Edit', summary: 'src/a.js', input: { file_path: 'src/a.js' } };
  const a = store.addMessage(id, { role: 'user', kind: 'text', content: 'hi "there"' });
  const b = store.addMessage(id, { role: 'agent', kind: 'step', content: step, runId: 'r1' });
  assert.equal(a.content, 'hi "there"');
  assert.equal(a.runId, null);
  assert.deepEqual(b.content, step);
  assert.equal(b.runId, 'r1');
  assert.deepEqual(store.listMessages(id), [a, b]);
  assert.deepEqual(store.listMessages(id, { after: a.id }), [b]);
  assert.deepEqual(store.listMessages(id, { after: b.id }), []);
});

test('keeps a small step input and a step without input as they are', () => {
  const { store, make } = fixture();
  const { id } = make();
  const noInput = store.addMessage(id, { role: 'agent', kind: 'step', content: { tool: 'Done', summary: 's' } });
  assert.deepEqual(noInput.content, { tool: 'Done', summary: 's' });
  const small = store.addMessage(id, { role: 'agent', kind: 'step', content: { tool: 'T', summary: 's', input: { text: 'x'.repeat(4000) } } });
  assert.equal(small.content.input.text.length, 4000);
});

test('truncates a step input over 4096 characters', () => {
  const { store, make } = fixture();
  const { id } = make();
  const msg = store.addMessage(id, { role: 'agent', kind: 'step', content: { tool: 'Write', summary: 'big', input: { text: 'x'.repeat(10_000) } } });
  assert.equal(msg.content.input.truncated, true);
  assert.equal(msg.content.input.preview.length, 4096);
  assert.equal(msg.content.input.preview, JSON.stringify({ text: 'x'.repeat(10_000) }).slice(0, 4096));
});

test('deleting a thread deletes its messages', () => {
  const { store, make } = fixture();
  const { id } = make();
  store.addMessage(id, { role: 'user', kind: 'text', content: 'hi' });
  store.deleteThread(id);
  assert.equal(store.getThread(id), null);
  assert.deepEqual(store.listMessages(id), []);
});

test('lists threads newest first, 50 per page, with a before cursor', () => {
  const { store, make } = fixture();
  for (let i = 0; i < 60; i++) make({ title: `t${i}` });
  const page = store.listThreads();
  assert.equal(page.length, 50);
  assert.equal(page[0].title, 't59');
  const rest = store.listThreads({ before: page.at(-1).updatedAt });
  assert.deepEqual(rest.map((t) => t.title), Array.from({ length: 10 }, (_, i) => `t${9 - i}`));
  assert.equal(store.listThreads({ limit: 3 }).length, 3);
});

test('filters by repo and status', () => {
  const { store, make } = fixture();
  make({ repo: 'api' });
  const web = make({ repo: 'web' });
  store.updateThread(web.id, { status: 'idle' });
  assert.deepEqual(store.listThreads({ repo: 'web' }).map((t) => t.id), [web.id]);
  assert.deepEqual(store.listThreads({ status: 'idle' }).map((t) => t.id), [web.id]);
  assert.deepEqual(store.listThreads({ repo: 'api', status: 'idle' }), []);
});

test('hides archived threads unless asked for them', () => {
  const { store, make } = fixture();
  const keep = make();
  const gone = make();
  store.updateThread(gone.id, { status: 'archived' });
  assert.deepEqual(store.listThreads().map((t) => t.id), [keep.id]);
  assert.deepEqual(store.listThreads({ status: 'archived' }).map((t) => t.id), [gone.id]);
});

test('searches titles and text messages, case-insensitively, escaping wildcards', () => {
  const { store, make } = fixture();
  const byTitle = make({ title: 'fix flaky test' });
  const byText = make({ title: 'other' });
  const byStep = make({ title: 'third' });
  const percent = make({ title: '100% done' });
  store.addMessage(byText.id, { role: 'agent', kind: 'text', content: 'this looks Flaky to me' });
  store.addMessage(byStep.id, { role: 'agent', kind: 'step', content: { tool: 'Bash', summary: 'flaky', input: { command: 'flaky' } } });
  assert.deepEqual(store.listThreads({ q: 'FLAKY' }).map((t) => t.id).sort(), [byTitle.id, byText.id].sort());
  assert.deepEqual(store.listThreads({ q: '100%' }).map((t) => t.id), [percent.id]);
  assert.deepEqual(store.listThreads({ q: '%' }).map((t) => t.id), [percent.id]);
  assert.deepEqual(store.listThreads({ q: 'a_b' }), []);
  assert.deepEqual(store.listThreads({ q: '\\' }), []);
});

test('projectStats counts non-archived and running threads per repo', () => {
  const { store, make } = fixture();
  const a1 = make({ repo: 'api' });
  make({ repo: 'api' });
  const a3 = make({ repo: 'api' });
  const w = make({ repo: 'web' });
  store.updateThread(a1.id, { status: 'idle' });
  store.updateThread(a3.id, { status: 'archived' });
  const stats = store.projectStats();
  assert.deepEqual(stats.map((s) => [s.repo, s.threads, s.running]).sort(), [['api', 2, 1], ['web', 1, 1]]);
  assert.equal(stats.find((s) => s.repo === 'web').lastActivity, store.getThread(w.id).updatedAt);
});

test('recoverInterrupted settles running threads by what they already have', () => {
  const { store, make } = fixture();
  const withSession = make();
  store.updateThread(withSession.id, { sessionId: 's1' });
  const withAgent = make();
  store.addMessage(withAgent.id, { role: 'agent', kind: 'text', content: 'an answer' });
  const bare = make();
  store.addMessage(bare.id, { role: 'user', kind: 'text', content: 'hi' });
  const done = make();
  store.updateThread(done.id, { status: 'idle' });

  assert.equal(store.recoverInterrupted(), 3);
  assert.equal(store.getThread(withSession.id).status, 'idle');
  assert.equal(store.getThread(withAgent.id).status, 'idle');
  assert.equal(store.getThread(bare.id).status, 'failed');
  assert.equal(store.getThread(done.id).status, 'idle');
  const last = store.listMessages(bare.id).at(-1);
  assert.deepEqual([last.role, last.kind, last.content], ['system', 'status', { outcome: 'interrupted', error: 'interrupted by a restart' }]);
  assert.equal(store.listMessages(done.id).length, 0);
  assert.equal(store.recoverInterrupted(), 0);
});
