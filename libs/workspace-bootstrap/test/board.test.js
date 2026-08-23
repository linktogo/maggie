import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { STATES, MAX_PENDING_MESSAGES, resolveBoardPath, readBoard, writeBoard, setSessionStatus, removeSession, closeSession, queueMessage, takePendingMessages, initRepos } from '../src/board.js';

function memIO(board) {
  const store = { json: JSON.stringify(board) };
  return {
    store,
    read: async () => store.json,
    write: async (_file, data) => { store.written = data; },
    move: async () => { store.json = store.written; },
    ensureDir: async () => {},
    tmpSuffix: '.tmp',
  };
}

test('STATES are the four kanban columns in order', () => {
  assert.deepEqual(STATES, ['todo', 'inprogress', 'question', 'done']);
});
test('resolveBoardPath prefers the explicit board option', () => {
  assert.equal(resolveBoardPath({ board: 'b.json', env: {} }), path.resolve('b.json'));
});
test('resolveBoardPath falls back to AI_SYNC_BOARD', () => {
  assert.equal(resolveBoardPath({ env: { AI_SYNC_BOARD: '/tmp/x/board.json' } }), '/tmp/x/board.json');
});
test('resolveBoardPath throws when neither is set', () => {
  assert.throws(() => resolveBoardPath({ env: {} }), /No board path/);
});

test('readBoard parses an existing v2 board and leaves sessions untouched', async () => {
  const sessions = { s1: { status: 'done', updatedAt: 'T', lastEvent: 'x', title: null, lastPrompt: null, events: [] } };
  const read = async () => JSON.stringify({ version: 2, repos: { a: { sessions } } });
  assert.deepEqual(await readBoard('/x', { read }), { version: 2, repos: { a: { sessions } } });
});

test('readBoard normalizes a v1 flat repo entry into the empty v2 sessions shape', async () => {
  const read = async () => JSON.stringify({ version: 1, repos: { a: { status: 'done', updatedAt: 'T', lastEvent: 'x', events: [] } } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board, { version: 2, repos: { a: { sessions: {} } } });
});

test('readBoard normalizes a repo entry with no sessions key to empty sessions', async () => {
  const read = async () => JSON.stringify({ repos: { a: {} } });
  const board = await readBoard('/x', { read });
  assert.deepEqual(board.repos.a, { sessions: {} });
});

test('readBoard returns an empty v2 board when the file is missing', async () => {
  const read = async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  assert.deepEqual(await readBoard('/x', { read }), { version: 2, repos: {} });
});
test('readBoard rethrows non-ENOENT errors', async () => {
  const read = async () => { const e = new Error('boom'); e.code = 'EACCES'; throw e; };
  await assert.rejects(() => readBoard('/x', { read }), /boom/);
});

test('writeBoard ensures the dir, writes a temp file, then renames (atomic)', async () => {
  const calls = [];
  await writeBoard('/d/board.json', { version: 2, repos: {} }, {
    ensureDir: async (dir, opts) => calls.push(['ensureDir', dir, opts]),
    write: async (file, data) => calls.push(['write', file, data]),
    move: async (from, to) => calls.push(['move', from, to]),
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(calls, [
    ['ensureDir', '/d', { recursive: true }],
    ['write', '/d/board.json.tmp', '{\n  "version": 2,\n  "repos": {}\n}\n'],
    ['move', '/d/board.json.tmp', '/d/board.json'],
  ]);
});

test('setSessionStatus creates a new session on a repo not yet on the board, storing the given title/lastPrompt', async () => {
  const board = await setSessionStatus('/x', 'oc-be', 'sess-1', 'question', {
    lastEvent: 'Notification', title: 'first prompt', lastPrompt: 'first prompt',
    now: () => '2026-06-16T10:00:00Z',
    read: async () => JSON.stringify({ version: 2, repos: {} }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos['oc-be'].sessions['sess-1'], {
    status: 'question',
    updatedAt: '2026-06-16T10:00:00Z',
    lastEvent: 'Notification',
    title: 'first prompt',
    lastPrompt: 'first prompt',
    startedAt: '2026-06-16T10:00:00Z',
    worktree: null,
    agent: null,
    usage: null,
    pendingMessages: [],
    events: [{ event: 'Notification', at: '2026-06-16T10:00:00Z' }],
  });
});

test('setSessionStatus updates an existing session without touching a sibling session', async () => {
  const board = await setSessionStatus('/x', 'oc-be', 'sess-1', 'inprogress', {
    lastEvent: 'UserPromptSubmit',
    now: () => 'T2',
    read: async () => JSON.stringify({
      version: 2,
      repos: { 'oc-be': { sessions: {
        'sess-1': { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'a', lastPrompt: 'a', events: [] },
        'sess-2': { status: 'done', updatedAt: 'T1', lastEvent: 'Stop', title: 'b', lastPrompt: 'b', events: [] },
      } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos['oc-be'].sessions['sess-1'].status, 'inprogress');
  assert.deepEqual(board.repos['oc-be'].sessions['sess-2'], { status: 'done', updatedAt: 'T1', lastEvent: 'Stop', title: 'b', lastPrompt: 'b', events: [] });
});

test('setSessionStatus sets title only on the first write and preserves it afterwards', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'first prompt', lastPrompt: 'first prompt', events: [] } } } },
  });
  const board = await setSessionStatus('/x', 'a', 's1', 'question', {
    title: 'a different title', now: () => 'T2', read,
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.title, 'first prompt');
});

test('setSessionStatus overwrites lastPrompt when passed and preserves the previous value when omitted', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 't', lastPrompt: 'old prompt', events: [] } } } },
  });
  const io = { now: () => 'T2', write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp' };

  const withNewPrompt = await setSessionStatus('/x', 'a', 's1', 'inprogress', { ...io, read, lastPrompt: 'new prompt' });
  assert.equal(withNewPrompt.repos.a.sessions.s1.lastPrompt, 'new prompt');

  const withoutPrompt = await setSessionStatus('/x', 'a', 's1', 'question', { ...io, read });
  assert.equal(withoutPrompt.repos.a.sessions.s1.lastPrompt, 'old prompt');
});

test('setSessionStatus sets startedAt only on the first write and preserves it afterwards', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: {
      status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 't', lastPrompt: 'p',
      startedAt: 'T0', usage: null, events: [],
    } } } },
  });
  const board = await setSessionStatus('/x', 'a', 's1', 'question', {
    startedAt: 'a different time', now: () => 'T2', read,
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.startedAt, 'T0');
});

test('setSessionStatus records the worktree on the first write and defaults to null without one', async () => {
  const io = { write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp' };
  const withWorktree = await setSessionStatus('/x', 'a', 's1', 'inprogress', { ...io, worktree: 'feat/login' });
  assert.equal(withWorktree.repos.a.sessions.s1.worktree, 'feat/login');
  const withoutWorktree = await setSessionStatus('/x', 'a', 's1', 'inprogress', io);
  assert.equal(withoutWorktree.repos.a.sessions.s1.worktree, null);
});

test('setSessionStatus sets worktree only on the first write and preserves it afterwards', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: {
      status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 't', lastPrompt: 'p',
      startedAt: 'T0', worktree: 'feat/login', usage: null, events: [],
    } } } },
  });
  const board = await setSessionStatus('/x', 'a', 's1', 'question', {
    worktree: 'other/branch', read,
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.worktree, 'feat/login');
});

test('setSessionStatus overwrites usage when passed and preserves the previous value when omitted', async () => {
  const oldUsage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 };
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: {
      status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 't', lastPrompt: 'p',
      startedAt: 'T0', usage: oldUsage, events: [],
    } } } },
  });
  const io = { now: () => 'T2', write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp' };
  const newUsage = { inputTokens: 5, outputTokens: 6, cacheCreationInputTokens: 7, cacheReadInputTokens: 8 };

  const withNewUsage = await setSessionStatus('/x', 'a', 's1', 'question', { ...io, read, usage: newUsage });
  assert.deepEqual(withNewUsage.repos.a.sessions.s1.usage, newUsage);

  const withoutUsage = await setSessionStatus('/x', 'a', 's1', 'inprogress', { ...io, read });
  assert.deepEqual(withoutUsage.repos.a.sessions.s1.usage, oldUsage);
});

test('setSessionStatus prepends events newest-first and caps history at MAX_EVENTS per session', async () => {
  const prior = Array.from({ length: 20 }, (_, i) => ({ event: `e${i}`, at: 'old' }));
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    lastEvent: 'pushed', now: () => 'NOW',
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'inprogress', events: prior } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  const events = board.repos.a.sessions.s1.events;
  assert.equal(events.length, 20);
  assert.deepEqual(events[0], { event: 'pushed', at: 'NOW' });
  assert.equal(events[19].event, 'e18'); // oldest entry dropped
});
test('setSessionStatus defaults lastEvent to manual', async () => {
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    now: () => 'T', read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(board.repos.a.sessions.s1.lastEvent, 'manual');
});
test('setSessionStatus rejects an invalid state', async () => {
  await assert.rejects(() => setSessionStatus('/x', 'a', 's1', 'bogus', {}), /Invalid state "bogus"/);
});
test('setSessionStatus stamps an ISO timestamp by default', async () => {
  const board = await setSessionStatus('/x', 'a', 's1', 'done', {
    read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.match(board.repos.a.sessions.s1.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('removeSession deletes one session and leaves a sibling session and other repos intact', async () => {
  const board = await removeSession('/x', 'a', 's1', {
    read: async () => JSON.stringify({
      version: 2,
      repos: {
        a: { sessions: { s1: { status: 'done' }, s2: { status: 'inprogress' } } },
        b: { sessions: { s3: { status: 'todo' } } },
      },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s2']);
  assert.deepEqual(Object.keys(board.repos.b.sessions), ['s3']);
});
test('removeSession is a no-op when the repo is not on the board', async () => {
  const board = await removeSession('/x', 'unknown', 's1', {
    read: async () => '{"version":2,"repos":{}}',
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos, {});
});
test('removeSession is a no-op when the session is not on the repo', async () => {
  const board = await removeSession('/x', 'a', 'unknown-session', {
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s1']);
});

test('initRepos adds missing repos with empty sessions without clobbering existing ones', async () => {
  const board = await initRepos('/x', ['a', 'b'], {
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos.a, { sessions: { s1: { status: 'done' } } });
  assert.deepEqual(board.repos.b, { sessions: {} });
});

test('closeSession appends a history entry and removes the session, leaving a sibling session untouched', async () => {
  const appends = [];
  const writes = [];
  const result = await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: {
        s1: {
          status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'fix bug', lastPrompt: 'fix bug',
          startedAt: 'T0', usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }, events: [],
        },
        s2: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'b', lastPrompt: 'b', startedAt: 'T0', usage: null, events: [] },
      } } },
    }),
    write: async (file, data) => writes.push([file, data]),
    move: async () => {},
    ensureDir: async () => {},
    append: async (file, data) => appends.push([file, data]),
    tmpSuffix: '.tmp',
  });
  assert.deepEqual(result, { closed: true });
  assert.equal(appends.length, 1);
  assert.equal(appends[0][0], '/x/history.jsonl');
  assert.deepEqual(JSON.parse(appends[0][1]), {
    repo: 'a', sessionId: 's1', title: 'fix bug', agent: null, startedAt: 'T0', endedAt: 'T2',
    usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
  });
  const written = JSON.parse(writes[0][1]);
  assert.deepEqual(Object.keys(written.repos.a.sessions), ['s2']);
});

test('closeSession records null usage when the session has none yet', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: null, lastPrompt: null, startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0].usage, null);
  assert.equal(appends[0].title, null);
});

test('closeSession records null startedAt when the session has none yet', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0].startedAt, null);
});

test('closeSession is a no-op and returns closed:false when the repo is not on the board', async () => {
  const result = await closeSession('/x/board.json', 'unknown', 's1', {
    historyPath: '/x/history.jsonl',
    read: async () => '{"version":2,"repos":{}}',
    write: async () => { throw new Error('must not write'); },
    append: async () => { throw new Error('must not append'); },
  });
  assert.deepEqual(result, { closed: false });
});

test('closeSession is a no-op and returns closed:false when the session is not on the repo', async () => {
  const result = await closeSession('/x/board.json', 'a', 'unknown-session', {
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'done' } } } } }),
    write: async () => { throw new Error('must not write'); },
    append: async () => { throw new Error('must not append'); },
  });
  assert.deepEqual(result, { closed: false });
});

test('closeSession defaults historyPath to the sibling history.jsonl when not passed', async () => {
  const appends = [];
  await closeSession('/d/board.json', 'a', 's1', {
    now: () => 'T2',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p', startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file) => appends.push(file),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0], path.join('/d', 'history.jsonl'));
});

test('closeSession stamps endedAt with the current ISO time by default', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p', startedAt: 'T0', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.match(appends[0].endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('setSessionStatus preserves pendingMessages across a status write', async () => {
  const read = async () => JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: {
      status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 't', lastPrompt: 'p',
      startedAt: 'T0', usage: null, pendingMessages: [{ text: 'hi', at: 'T0' }], events: [],
    } } } },
  });
  const board = await setSessionStatus('/x', 'a', 's1', 'inprogress', {
    now: () => 'T2', read, write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.deepEqual(board.repos.a.sessions.s1.pendingMessages, [{ text: 'hi', at: 'T0' }]);
});

test('queueMessage appends a message with a timestamp to an existing session', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'question', pendingMessages: [] } } } } });
  const result = await queueMessage('/x', 'a', 's1', 'ship it', { now: () => 'T1', ...io });
  assert.deepEqual(result, { queued: true, count: 1 });
  const board = JSON.parse(io.store.json);
  assert.deepEqual(board.repos.a.sessions.s1.pendingMessages, [{ text: 'ship it', at: 'T1' }]);
});

test('queueMessage appends after existing queued messages, preserving order', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'question', pendingMessages: [{ text: 'first', at: 'T0' }] } } } } });
  await queueMessage('/x', 'a', 's1', 'second', { now: () => 'T1', ...io });
  const board = JSON.parse(io.store.json);
  assert.deepEqual(board.repos.a.sessions.s1.pendingMessages, [{ text: 'first', at: 'T0' }, { text: 'second', at: 'T1' }]);
});

test('queueMessage tolerates a session that has no pendingMessages array yet', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'question' } } } } });
  await queueMessage('/x', 'a', 's1', 'hello', { now: () => 'T1', ...io });
  const board = JSON.parse(io.store.json);
  assert.deepEqual(board.repos.a.sessions.s1.pendingMessages, [{ text: 'hello', at: 'T1' }]);
});

test('queueMessage caps the queue at MAX_PENDING_MESSAGES, dropping the oldest', async () => {
  const existing = Array.from({ length: MAX_PENDING_MESSAGES }, (_, i) => ({ text: `m${i}`, at: 'old' }));
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'question', pendingMessages: existing } } } } });
  const result = await queueMessage('/x', 'a', 's1', 'newest', { now: () => 'T1', ...io });
  assert.equal(result.count, MAX_PENDING_MESSAGES);
  const board = JSON.parse(io.store.json);
  const queue = board.repos.a.sessions.s1.pendingMessages;
  assert.equal(queue.length, MAX_PENDING_MESSAGES);
  assert.deepEqual(queue[0], { text: 'm1', at: 'old' });
  assert.deepEqual(queue[queue.length - 1], { text: 'newest', at: 'T1' });
});

test('queueMessage returns { queued: false } and writes nothing for an unknown session', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: {} } } });
  const result = await queueMessage('/x', 'a', 'nope', 'hi', { now: () => 'T1', ...io });
  assert.deepEqual(result, { queued: false });
  assert.equal(io.store.written, undefined);
});

test('takePendingMessages drains the queue and clears it on the board', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'inprogress', pendingMessages: [{ text: 'a', at: 'T0' }, { text: 'b', at: 'T1' }] } } } } });
  const drained = await takePendingMessages('/x', 'a', 's1', io);
  assert.deepEqual(drained, [{ text: 'a', at: 'T0' }, { text: 'b', at: 'T1' }]);
  const board = JSON.parse(io.store.json);
  assert.deepEqual(board.repos.a.sessions.s1.pendingMessages, []);
});

test('takePendingMessages returns [] and writes nothing when the queue is empty', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'inprogress', pendingMessages: [] } } } } });
  const drained = await takePendingMessages('/x', 'a', 's1', io);
  assert.deepEqual(drained, []);
  assert.equal(io.store.written, undefined);
});

test('takePendingMessages returns [] for an unknown session', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: {} } } });
  const drained = await takePendingMessages('/x', 'a', 'nope', io);
  assert.deepEqual(drained, []);
  assert.equal(io.store.written, undefined);
});

test('queueMessage stamps an ISO timestamp when no clock is injected', async () => {
  const io = memIO({ version: 2, repos: { a: { sessions: { s1: { status: 'question', pendingMessages: [] } } } } });
  await queueMessage('/x', 'a', 's1', 'hi', io);
  const board = JSON.parse(io.store.json);
  assert.match(board.repos.a.sessions.s1.pendingMessages[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('setSessionStatus records the agent once and never overwrites it afterwards', async () => {
  const first = await setSessionStatus('/x', 'a', 's1', 'inprogress', {
    lastEvent: 'userPromptSubmitted', agent: 'copilot', now: () => 'T1',
    read: async () => JSON.stringify({ version: 2, repos: {} }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(first.repos.a.sessions.s1.agent, 'copilot');

  const second = await setSessionStatus('/x', 'a', 's1', 'question', {
    lastEvent: 'agentStop', agent: 'claude', now: () => 'T2',
    read: async () => JSON.stringify(first),
    write: async () => {}, move: async () => {}, ensureDir: async () => {}, tmpSuffix: '.tmp',
  });
  assert.equal(second.repos.a.sessions.s1.agent, 'copilot');
});

test('closeSession carries the session agent into the history entry', async () => {
  const appends = [];
  await closeSession('/x/board.json', 'a', 's1', {
    now: () => 'T2',
    historyPath: '/x/history.jsonl',
    read: async () => JSON.stringify({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'question', agent: 'copilot', startedAt: 'T0', title: 't', usage: null, events: [] } } } },
    }),
    write: async () => {}, move: async () => {}, ensureDir: async () => {},
    append: async (file, data) => appends.push(JSON.parse(data)),
    tmpSuffix: '.tmp',
  });
  assert.equal(appends[0].agent, 'copilot');
});
