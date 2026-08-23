import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoardServer, startFromArgv, resolveServerBoardPath } from './server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function listening(server) {
  return new Promise((resolve) => server.on('listening', () => resolve(server.address().port)));
}

test('GET /api/board returns the board JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  await writeFile(boardPath, JSON.stringify({ version: 1, repos: { a: { status: 'todo' } } }));
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1, repos: { a: { status: 'todo' } } });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/board returns an empty board when the file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'nope.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  assert.deepEqual(await res.json(), { version: 2, repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/history returns the parsed entries from history.jsonl', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const entry1 = {
    repo: 'a', sessionId: 's1', title: 't1', startedAt: 'T0', endedAt: 'T1',
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
  };
  const entry2 = {
    repo: 'b', sessionId: 's2', title: 't2', startedAt: 'T0', endedAt: 'T1',
    usage: { inputTokens: 2, outputTokens: 2, cacheCreationInputTokens: 2, cacheReadInputTokens: 2 },
  };
  await writeFile(path.join(dir, 'history.jsonl'), `${JSON.stringify(entry1)}\n${JSON.stringify(entry2)}\n`);
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/history`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [entry1, entry2]);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/history returns an empty array when history.jsonl is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/history`);
  assert.deepEqual(await res.json(), []);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/history skips a malformed line and returns the valid entries around it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const entry = {
    repo: 'a', sessionId: 's1', title: 't1', startedAt: 'T0', endedAt: 'T1',
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
  };
  await writeFile(path.join(dir, 'history.jsonl'), `${JSON.stringify(entry)}\n{not json\n`);
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/history`);
  assert.deepEqual(await res.json(), [entry]);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('serves a static file from distDir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>board</h1>');
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.equal(await res.text(), '<h1>board</h1>');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('unknown path falls back to index.html (SPA)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  await writeFile(path.join(dir, 'index.html'), '<h1>spa</h1>');
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/anything`);
  assert.equal(await res.text(), '<h1>spa</h1>');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/config maps the resolved config repos to name -> metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const config = {
    repos: [{ name: 'oc-be', url: 'https://h/oc-be.git', technologies: ['nestjs'], targets: ['claude'] }],
  };
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, config });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await res.json(), {
    repos: { 'oc-be': { url: 'https://h/oc-be.git', technologies: ['nestjs'], targets: ['claude'] } },
  });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/config returns empty repos when no config is configured', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.deepEqual(await res.json(), { repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close closes an existing session: removes it from the board and appends history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  await writeFile(boardPath, JSON.stringify({
    version: 2,
    repos: { a: { sessions: {
      s1: {
        status: 'question', updatedAt: 'T1', lastEvent: 'Stop', title: 'fix bug', lastPrompt: 'fix bug',
        startedAt: 'T0', usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }, events: [],
      },
      s2: { status: 'inprogress', updatedAt: 'T1', lastEvent: 'x', title: 'b', lastPrompt: 'b', startedAt: 'T0', usage: null, events: [] },
    } } },
  }));
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 's1' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { closed: true });
  const board = JSON.parse(await readFile(boardPath, 'utf8'));
  assert.deepEqual(Object.keys(board.repos.a.sessions), ['s2']);
  const historyLines = (await readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(historyLines.length, 1);
  const historyEntry = JSON.parse(historyLines[0]);
  assert.equal(historyEntry.repo, 'a');
  assert.equal(historyEntry.sessionId, 's1');
  assert.deepEqual(historyEntry.usage, { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 404 for an unknown session and leaves the board untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const original = JSON.stringify({ version: 2, repos: { a: { sessions: { s1: { status: 'question' } } } } });
  await writeFile(boardPath, original);
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 'unknown' }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { closed: false });
  assert.equal(await readFile(boardPath, 'utf8'), original);
  await assert.rejects(() => readFile(path.join(dir, 'history.jsonl')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 400 when repo or sessionId is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a' }),
  });
  assert.equal(res.status, 400);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/close returns 400 for an unparsable body', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('resolveServerBoardPath: explicit --board wins over everything', () => {
  const wkBoard = path.resolve('/c', 'wk', '.maggie', 'board.json');
  assert.equal(
    resolveServerBoardPath({ board: 'x/b.json', env: { AI_SYNC_BOARD: '/e.json' }, cwd: '/c', exists: () => true }),
    path.resolve('/c', 'x/b.json'),
  );
  assert.notEqual(resolveServerBoardPath({ board: 'x/b.json', cwd: '/c', exists: () => true }), wkBoard);
});

test('resolveServerBoardPath: AI_SYNC_BOARD wins over auto-detect', () => {
  assert.equal(
    resolveServerBoardPath({ env: { AI_SYNC_BOARD: '/e/board.json' }, cwd: '/c', exists: () => true }),
    path.resolve('/c', '/e/board.json'),
  );
});

test('resolveServerBoardPath: auto-detects wk/.maggie/board.json when present', () => {
  const wkBoard = path.resolve('/c', 'wk', '.maggie', 'board.json');
  assert.equal(
    resolveServerBoardPath({ env: {}, cwd: '/c', exists: (p) => p === wkBoard }),
    wkBoard,
  );
});

test('resolveServerBoardPath: falls back to ./board.json when no workspace board exists', () => {
  assert.equal(
    resolveServerBoardPath({ env: {}, cwd: '/c', exists: () => false }),
    path.resolve('/c', 'board.json'),
  );
});

test('startFromArgv falls back to the next port when the chosen one is busy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const blocker = createServer((_req, res) => res.end());
  // Bind on all interfaces (no host) so it conflicts with startFromArgv's default bind.
  const busyPort = await new Promise((resolve) => blocker.listen(0, () => resolve(blocker.address().port)));
  const logs = [];
  const server = await startFromArgv(
    ['--board', path.join(dir, 'board.json'), '--port', String(busyPort), '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  const boundPort = await listening(server);
  assert.equal(boundPort, busyPort + 1);
  assert.ok(logs.some((m) => m.includes(`Port ${busyPort} is already in use`)));
  server.close();
  blocker.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv reconciles a repo\'s hooks on start and logs what changed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const checkout = path.join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  const boardPath = path.join(dir, '.maggie', 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({
    repos: [{ name: 'demo', url: 'https://h/demo.git', path: checkout, technologies: ['nestjs'], targets: ['claude'] }],
  }));
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(logs.some((m) => m.includes('✓ demo: claude hooks repointed')));
  const settings = JSON.parse(await readFile(path.join(checkout, '.claude', 'settings.local.json'), 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /status demo inprogress --board/);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv logs "all up to date" on a second start once hooks are already correct', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const checkout = path.join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  const boardPath = path.join(dir, '.maggie', 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, JSON.stringify({
    repos: [{ name: 'demo', url: 'https://h/demo.git', path: checkout, technologies: ['nestjs'], targets: ['claude'] }],
  }));
  const firstServer = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: () => {} },
  );
  await listening(firstServer);
  firstServer.close();

  const logs = [];
  const secondServer = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(secondServer);
  assert.ok(logs.some((m) => m.includes('hooks verified for 1 repo(s), all up to date')));
  secondServer.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv performs no hook reconciliation when --config is not given', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(!logs.some((m) => m.includes('hooks')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv logs a warning and still starts when the config file is invalid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const configPath = path.join(dir, 'repos.json');
  await writeFile(configPath, '{not json');
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config', configPath, '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(logs.some((m) => m.includes('⚠ hook reconciliation skipped')));
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/ci returns the reader payload for the configured repos', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const config = { repos: [{ name: 'lk-myasso' }, { name: 'lk-mind' }] };
  const seen = [];
  const ciReader = { read: async (names) => { seen.push(names); return { generatedAt: 'now', lastSyncError: null, repos: {} }; } };
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir, config, ciReader });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/ci`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { generatedAt: 'now', lastSyncError: null, repos: {} });
  assert.deepEqual(seen[0], ['lk-myasso', 'lk-mind']);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv loads config from --config-repo and serves it at /api/config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const checkout = path.join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  const config = {
    repos: [{ name: 'demo', url: 'https://h/demo.git', path: checkout, technologies: ['nestjs'], targets: ['claude'] }],
  };
  const boardPath = path.join(dir, '.maggie', 'board.json');
  let repoArgs;
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config-repo', 'git@host:o/config.git', '--config-file', 'repos.json', '--port', '0', '--dist', dir],
    {
      log: (m) => logs.push(m),
      loadConfigFromRepo: async (url, opts) => { repoArgs = { url, opts }; return config; },
    },
  );
  await listening(server);
  assert.equal(repoArgs.url, 'git@host:o/config.git');
  assert.equal(repoArgs.opts.configFile, 'repos.json');
  assert.ok(logs.some((m) => m.includes('✓ demo: claude hooks repointed')));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
  assert.deepEqual(await res.json(), {
    repos: { demo: { url: 'https://h/demo.git', technologies: ['nestjs'], targets: ['claude'] } },
  });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('GET /api/ci reports unavailable when no reader is wired', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/ci`);
  const body = await res.json();
  assert.deepEqual(body.repos, {});
  assert.equal(body.lastSyncError, 'status repo not configured');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('startFromArgv logs a warning when both --config and --config-repo are given', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const logs = [];
  const server = await startFromArgv(
    ['--board', boardPath, '--config', 'repos.json', '--config-repo', 'git@host:o/config.git', '--port', '0', '--dist', dir],
    { log: (m) => logs.push(m) },
  );
  await listening(server);
  assert.ok(logs.some((m) => m.includes('Pass either --config or --config-repo, not both')));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
  assert.deepEqual(await res.json(), { repos: {} });
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/message queues a message onto an existing session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  await writeFile(boardPath, JSON.stringify({
    version: 2,
    repos: { a: { sessions: { s1: { status: 'question', updatedAt: 'T1', lastEvent: 'Stop', pendingMessages: [] } } } },
  }));
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 's1', message: '  please rebase  ' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { queued: true, count: 1 });
  const board = JSON.parse(await readFile(boardPath, 'utf8'));
  assert.equal(board.repos.a.sessions.s1.pendingMessages.length, 1);
  assert.equal(board.repos.a.sessions.s1.pendingMessages[0].text, 'please rebase');
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/message returns 404 for an unknown session and leaves the board untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const boardPath = path.join(dir, 'board.json');
  const original = JSON.stringify({ version: 2, repos: { a: { sessions: {} } } });
  await writeFile(boardPath, original);
  const server = createBoardServer({ boardPath, distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a', sessionId: 'nope', message: 'hi' }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { queued: false });
  assert.equal(await readFile(boardPath, 'utf8'), original);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/message returns 400 when repo, sessionId or a non-empty message is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  for (const body of [
    { repo: 'a', sessionId: 's1' },
    { repo: 'a', sessionId: 's1', message: '   ' },
    { sessionId: 's1', message: 'hi' },
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
  }
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('POST /api/sessions/message returns 400 for an unparsable body', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'board-'));
  const server = createBoardServer({ boardPath: path.join(dir, 'board.json'), distDir: dir });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  server.close();
  await rm(dir, { recursive: true, force: true });
});
