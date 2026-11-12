import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/main.js';
import { resolveHistoryPath } from '@linktogo/maggie-workspace-bootstrap';

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function ttyStdin() {
  return { isTTY: true };
}

function pipedStdin(payload) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
  };
}

function emptyPipedStdin() {
  return { isTTY: false, async *[Symbol.asyncIterator]() {} };
}

function malformedPipedStdin() {
  return { isTTY: false, async *[Symbol.asyncIterator]() { yield Buffer.from('{not json'); } };
}

const config = {
  defaultTargets: ['claude'],
  repos: [
    { name: 'a', url: 'git@host:a.git', technologies: ['nestjs'], targets: ['claude'] },
    { name: 'b', url: 'git@host:b.git', technologies: ['nestjs'], targets: ['claude'] },
  ],
};

test('main requires --config or --config-repo', async () => {
  await assert.rejects(
    () => main([], { loadConfig: async () => config, logger: silentLogger() }),
    /Missing required --config <path> or --config-repo/,
  );
});

test('main can load config from a repo via --config-repo', async () => {
  let repoArgs;
  let received;
  await main(['--config-repo', 'git@github.com:o/ai-config.git', '--config-file', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfigFromRepo: async (url, opts) => { repoArgs = { url, opts }; return config; },
    runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(repoArgs.url, 'git@github.com:o/ai-config.git');
  assert.equal(repoArgs.opts.configFile, 'repos.json');
  assert.equal(received.workspaceDir, path.resolve('/tmp/ws'));
});

test('main requires --workspace', async () => {
  await assert.rejects(
    () => main(['--config', 'repos.json'], { loadConfig: async () => config, logger: silentLogger() }),
    /Missing required --workspace/,
  );
});

test('main loads config, resolves the workspace path, and forwards flags', async () => {
  let received;
  const code = await main(
    ['--config', 'repos.json', '--workspace', 'ws', '--editor', 'vscode', '--repo', 'a', '--worktree', 'feat/z', '--no-install', '--dry-run', '--offline'],
    {
      loadConfig: async (p) => { assert.equal(p, 'repos.json'); return config; },
      runBootstrap: async (cfg, opts) => { received = opts; return {}; },
      logger: silentLogger(),
    },
  );

  assert.equal(code, 0);
  assert.equal(received.editor, 'vscode');
  assert.equal(received.repoFilter, 'a');
  assert.equal(received.worktree, 'feat/z');
  assert.equal(received.install, false);
  assert.equal(received.dryRun, true);
  assert.equal(received.offline, true);
  assert.equal(received.workspaceDir, path.resolve('ws'));
});

test('main prompts for a single repo and forwards onExisting on an interactive TTY', async () => {
  let promptedWith;
  let received;
  const onExisting = async () => 'reuse';
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config,
    isInteractive: true,
    selectRepo: async (repos) => { promptedWith = repos; return 'b'; },
    onExisting,
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.deepEqual(promptedWith, config.repos);
  assert.equal(received.repoFilter, 'b');
  assert.equal(received.onExisting, onExisting);
});

test('main does not prompt when --repo is provided even interactively', async () => {
  let prompted = false;
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws', '--repo', 'a'], {
    loadConfig: async () => config,
    isInteractive: true,
    selectRepo: async () => { prompted = true; return 'b'; },
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.equal(prompted, false);
  assert.equal(received.repoFilter, 'a');
});

test('main routes the status subcommand to setSessionStatus using the piped session id', async () => {
  const calls = [];
  const code = await main(['status', 'oc-be', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async (boardPath, repo, sessionId, state, o) => { calls.push({ boardPath, repo, sessionId, state, o }); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop' }),
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    boardPath: path.resolve('/b.json'), repo: 'oc-be', sessionId: 'sess-1', state: 'question', o: { lastEvent: 'Stop', agent: 'claude' },
  }]);
});

test('status subcommand forwards --worktree to setSessionStatus', async () => {
  let received;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--worktree', 'feat/login'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(received.worktree, 'feat/login');
});

test('status subcommand omits worktree when the flag is absent', async () => {
  let received;
  await main(['status', 'a', 'inprogress', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.ok(!('worktree' in received));
});

test('status subcommand requires repo and state', async () => {
  await assert.rejects(
    () => main(['status', 'oc-be', '--board', '/b.json'], { setSessionStatus: async () => {}, logger: silentLogger() }),
    /Usage: .*status <repo> <state>/,
  );
});

test('status subcommand defaults lastEvent to manual and falls back to a "manual" session on a TTY', async () => {
  let received;
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId, _s, o) => { receivedSessionId = sessionId; received = o; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
  assert.deepEqual(received, { lastEvent: 'manual', agent: 'claude' });
});

test('status subcommand targets an explicit session via --session instead of falling back to "manual"', async () => {
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json', '--session', 'sess-1'], {
    setSessionStatus: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'sess-1');
});

test('status subcommand extracts and truncates the title, and forwards the full lastPrompt, on UserPromptSubmit', async () => {
  let received;
  const longPrompt = 'x'.repeat(80);
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: longPrompt }),
    logger: silentLogger(),
  });
  assert.equal(received.title, `${'x'.repeat(59)}…`);
  assert.equal(received.lastPrompt, longPrompt);
});

test('status subcommand does not truncate a prompt at or under 60 characters', async () => {
  let received;
  const shortPrompt = 'x'.repeat(60);
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: shortPrompt }),
    logger: silentLogger(),
  });
  assert.equal(received.title, shortPrompt);
});

test('status subcommand skips title/lastPrompt when UserPromptSubmit has no prompt string', async () => {
  let received;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit' }),
    logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'UserPromptSubmit', agent: 'claude' });
});

test('status subcommand does not forward a title/lastPrompt on Notification or Stop', async () => {
  let received;
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop' }),
    logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'Stop', agent: 'claude' });
});

test('status subcommand computes usage from the transcript on Stop and forwards it', async () => {
  let received;
  const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 };
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    readTranscriptUsage: async (transcriptPath) => {
      assert.equal(transcriptPath, '/t.jsonl');
      return usage;
    },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop', transcript_path: '/t.jsonl' }),
    logger: silentLogger(),
  });
  assert.deepEqual(received, { lastEvent: 'Stop', agent: 'claude', usage });
});

test('status subcommand does not compute usage on UserPromptSubmit even with a transcript path', async () => {
  let received;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    readTranscriptUsage: async () => { throw new Error('should not be called'); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', transcript_path: '/t.jsonl' }),
    logger: silentLogger(),
  });
  assert.equal(received.usage, undefined);
});

test('status subcommand drains queued dashboard messages and relays them on UserPromptSubmit', async () => {
  const logs = [];
  let takeArgs;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async () => {},
    takePendingMessages: async (boardPath, repo, sessionId) => {
      takeArgs = { boardPath, repo, sessionId };
      return [{ text: 'first message', at: 'T0' }, { text: 'second message', at: 'T1' }];
    },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.deepEqual(takeArgs, { boardPath: path.resolve('/b.json'), repo: 'a', sessionId: 'sess-1' });
  assert.match(logs[0], /Message\(s\) sent from the board dashboard/);
  assert.match(logs[0], /- first message/);
  assert.match(logs[0], /- second message/);
});

test('status subcommand does not drain messages on non-UserPromptSubmit events', async () => {
  let called = false;
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'Stop'], {
    setSessionStatus: async () => {},
    takePendingMessages: async () => { called = true; return []; },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'Stop' }),
    logger: silentLogger(),
  });
  assert.equal(called, false);
});

test('status subcommand relays nothing when the queue is empty on UserPromptSubmit', async () => {
  const logs = [];
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'UserPromptSubmit'], {
    setSessionStatus: async () => {},
    takePendingMessages: async () => [],
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    logger: { log: (m) => logs.push(m), warn() {}, error() {} },
  });
  assert.deepEqual(logs, ['a [sess-1] → inprogress']);
});

test('status subcommand falls back to an empty payload when stdin is piped but empty', async () => {
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: emptyPipedStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('status subcommand falls back to an empty payload when stdin contains invalid JSON', async () => {
  let receivedSessionId;
  await main(['status', 'a', 'done', '--board', '/b.json'], {
    setSessionStatus: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: malformedPipedStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('main routes the session-end subcommand to removeSession using the piped session id', async () => {
  const calls = [];
  const code = await main(['session-end', 'oc-be', '--board', '/b.json'], {
    readBoard: async () => ({ version: 2, repos: {} }),
    removeSession: async (boardPath, repo, sessionId) => { calls.push({ boardPath, repo, sessionId }); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ boardPath: path.resolve('/b.json'), repo: 'oc-be', sessionId: 'sess-1' }]);
});

test('session-end subcommand requires repo', async () => {
  await assert.rejects(
    () => main(['session-end', '--board', '/b.json'], { removeSession: async () => {}, logger: silentLogger() }),
    /Usage: .*session-end <repo>/,
  );
});

test('session-end subcommand falls back to a "manual" session on a TTY', async () => {
  let receivedSessionId;
  await main(['session-end', 'a', '--board', '/b.json'], {
    readBoard: async () => ({ version: 2, repos: {} }),
    removeSession: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});

test('session-end subcommand writes a history entry using the outgoing session\'s title/startedAt and freshly computed usage, before removing the session', async () => {
  const appendCalls = [];
  const removeCalls = [];
  const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 };
  const boardPath = path.resolve('/b.json');
  await main(['session-end', 'oc-be', '--board', '/b.json'], {
    readBoard: async () => ({
      version: 2,
      repos: { 'oc-be': { sessions: { 'sess-1': { status: 'question', title: 'fix login', startedAt: 'T0', usage: null } } } },
    }),
    readTranscriptUsage: async (transcriptPath) => {
      assert.equal(transcriptPath, '/t.jsonl');
      return usage;
    },
    appendHistoryEntry: async (historyPath, entry) => appendCalls.push({ historyPath, entry }),
    removeSession: async (bp, repo, sessionId) => removeCalls.push({ boardPath: bp, repo, sessionId }),
    now: () => '2026-06-16T12:00:00Z',
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'SessionEnd', source: 'other', transcript_path: '/t.jsonl' }),
    logger: silentLogger(),
  });
  assert.deepEqual(appendCalls, [{
    historyPath: resolveHistoryPath(boardPath),
    entry: { repo: 'oc-be', sessionId: 'sess-1', title: 'fix login', agent: 'claude', startedAt: 'T0', endedAt: '2026-06-16T12:00:00Z', usage },
  }]);
  assert.deepEqual(removeCalls, [{ boardPath, repo: 'oc-be', sessionId: 'sess-1' }]);
});

test('session-end subcommand falls back to the session\'s last known usage when no transcript path is piped', async () => {
  const appendCalls = [];
  const lastUsage = { inputTokens: 9, outputTokens: 9, cacheCreationInputTokens: 9, cacheReadInputTokens: 9 };
  await main(['session-end', 'a', '--board', '/b.json'], {
    readBoard: async () => ({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'done', title: 't', startedAt: 'T0', usage: lastUsage } } } },
    }),
    readTranscriptUsage: async () => { throw new Error('should not be called'); },
    appendHistoryEntry: async (_h, entry) => appendCalls.push(entry),
    removeSession: async () => {},
    now: () => 'T2',
    stdin: pipedStdin({ session_id: 's1', hook_event_name: 'SessionEnd', source: 'clear' }),
    logger: silentLogger(),
  });
  assert.deepEqual(appendCalls[0].usage, lastUsage);
});

test('session-end subcommand defaults title/startedAt/usage to null for a bare session record and computes endedAt from the real clock', async () => {
  const appendCalls = [];
  await main(['session-end', 'a', '--board', '/b.json'], {
    readBoard: async () => ({ version: 2, repos: { a: { sessions: { s1: { status: 'todo' } } } } }),
    appendHistoryEntry: async (_h, entry) => appendCalls.push(entry),
    removeSession: async () => {},
    stdin: pipedStdin({ session_id: 's1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: silentLogger(),
  });
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].title, null);
  assert.equal(appendCalls[0].startedAt, null);
  assert.equal(appendCalls[0].usage, null);
  assert.equal(typeof appendCalls[0].endedAt, 'string');
});

test('session-end subcommand skips the history write for an unknown repo/session but still removes it', async () => {
  const appendCalls = [];
  const removeCalls = [];
  await main(['session-end', 'unknown-repo', '--board', '/b.json'], {
    readBoard: async () => ({ version: 2, repos: {} }),
    appendHistoryEntry: async (_h, entry) => appendCalls.push(entry),
    removeSession: async (boardPath, repo, sessionId) => removeCalls.push({ boardPath, repo, sessionId }),
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: silentLogger(),
  });
  assert.deepEqual(appendCalls, []);
  assert.equal(removeCalls.length, 1);
});

test('session-end subcommand still removes the session and logs a warning when recording history fails', async () => {
  const removeCalls = [];
  const warnings = [];
  await main(['session-end', 'a', '--board', '/b.json'], {
    readBoard: async () => ({
      version: 2,
      repos: { a: { sessions: { s1: { status: 'done', title: 't', startedAt: 'T0', usage: null } } } },
    }),
    appendHistoryEntry: async () => { throw new Error('disk full'); },
    removeSession: async (boardPath, repo, sessionId) => removeCalls.push({ boardPath, repo, sessionId }),
    stdin: pipedStdin({ session_id: 's1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: { log() {}, warn: (m) => warnings.push(m) },
  });
  assert.equal(removeCalls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to record token-usage history/);
});

test('main accepts an explicit bootstrap subcommand', async () => {
  let received;
  await main(['bootstrap', '--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config, runBootstrap: async (_c, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });
  assert.equal(received.editor, 'claude');
});

test('main defaults editor to claude and install to true', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config,
    runBootstrap: async (cfg, opts) => { received = opts; return {}; },
    logger: silentLogger(),
  });

  assert.equal(received.editor, 'claude');
  assert.equal(received.install, true);
  assert.equal(received.dryRun, false);
  assert.equal(received.offline, false);
  assert.equal(received.repoFilter, undefined);
});

// --- GitHub Copilot CLI wiring -------------------------------------------

function recordingLogger() {
  const out = [];
  const err = [];
  return { out, err, log: (l) => out.push(l), warn: (l) => err.push(l), error: (l) => err.push(l) };
}

test('status subcommand reads a camelCase Copilot payload and records the agent', async () => {
  let received;
  let receivedSessionId;
  await main(['status', 'a', 'inprogress', '--board', '/b.json', '--event', 'userPromptSubmitted', '--agent', 'copilot'], {
    setSessionStatus: async (_p, _r, sid, _s, o) => { receivedSessionId = sid; received = o; },
    takePendingMessages: async () => [],
    stdin: pipedStdin({ sessionId: 'cop-1', timestamp: 1, cwd: '/w', prompt: 'ship the thing' }),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'cop-1');
  assert.deepEqual(received, {
    lastEvent: 'userPromptSubmitted', agent: 'copilot', title: 'ship the thing', lastPrompt: 'ship the thing',
  });
});

test('status subcommand reads Copilot token usage from the events stream on agentStop', async () => {
  let received;
  const usage = { inputTokens: 7, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'agentStop', '--agent', 'copilot'], {
    setSessionStatus: async (_p, _r, _sid, _s, o) => { received = o; },
    takePendingMessages: async () => [],
    readTranscriptUsage: async () => { throw new Error('the Claude reader must not be used'); },
    readCopilotTranscriptUsage: async (transcriptPath) => {
      assert.equal(transcriptPath, '/home/u/.copilot/session-state/cop-1/events.jsonl');
      return usage;
    },
    stdin: pipedStdin({ sessionId: 'cop-1', transcriptPath: '/home/u/.copilot/session-state/cop-1/events.jsonl' }),
    logger: silentLogger(),
  });
  assert.equal(received.usage, usage);
});

test('under Copilot the status line goes to stderr so stdout stays parsable JSON', async () => {
  const logger = recordingLogger();
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'agentStop', '--agent', 'copilot'], {
    setSessionStatus: async () => {},
    takePendingMessages: async () => { throw new Error('agentStop output is dropped, do not drain'); },
    stdin: pipedStdin({ sessionId: 'cop-1' }),
    logger,
  });
  assert.deepEqual(logger.out, []);
  assert.deepEqual(logger.err, ['a [cop-1] → question']);
});

test('a Copilot notification drains queued messages as an additionalContext reply', async () => {
  const logger = recordingLogger();
  const drained = [];
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'notification', '--agent', 'copilot'], {
    setSessionStatus: async () => {},
    takePendingMessages: async (_bp, repo, sid) => { drained.push([repo, sid]); return [{ text: 'use pnpm' }, { text: 'and rebase' }]; },
    stdin: pipedStdin({ sessionId: 'cop-1' }),
    logger,
  });
  assert.deepEqual(drained, [['a', 'cop-1']]);
  assert.equal(logger.out.length, 1);
  const reply = JSON.parse(logger.out[0]);
  assert.match(reply.additionalContext, /^\[maggie\] Message\(s\) sent from the board dashboard/);
  assert.match(reply.additionalContext, /- use pnpm\n- and rebase$/);
});

test('a Copilot notification with an empty queue writes nothing to stdout', async () => {
  const logger = recordingLogger();
  await main(['status', 'a', 'question', '--board', '/b.json', '--event', 'notification', '--agent', 'copilot'], {
    setSessionStatus: async () => {},
    takePendingMessages: async () => [],
    stdin: pipedStdin({ sessionId: 'cop-1' }),
    logger,
  });
  assert.deepEqual(logger.out, []);
});

test('messages subcommand drains the queue for the piped Copilot session', async () => {
  const logger = recordingLogger();
  let boardPathSeen;
  await main(['messages', 'a', '--board', '/b.json', '--agent', 'copilot'], {
    takePendingMessages: async (bp, repo, sid) => {
      boardPathSeen = bp;
      assert.equal(repo, 'a');
      assert.equal(sid, 'cop-1');
      return [{ text: 'welcome back' }];
    },
    stdin: pipedStdin({ sessionId: 'cop-1', source: 'resume' }),
    logger,
  });
  assert.equal(boardPathSeen, path.resolve('/b.json'));
  assert.equal(JSON.parse(logger.out[0]).additionalContext, '[maggie] Message(s) sent from the board dashboard while you were away:\n- welcome back');
});

test('messages subcommand reports an empty queue on stderr under Copilot, stdout on Claude', async () => {
  const copilot = recordingLogger();
  await main(['messages', 'a', '--board', '/b.json', '--agent', 'copilot', '--session', 's1'], {
    takePendingMessages: async () => [],
    stdin: ttyStdin(),
    logger: copilot,
  });
  assert.deepEqual(copilot.out, []);
  assert.deepEqual(copilot.err, ['a [s1] no queued message']);

  const claude = recordingLogger();
  await main(['messages', 'a', '--board', '/b.json'], {
    takePendingMessages: async () => [],
    stdin: ttyStdin(),
    logger: claude,
  });
  assert.deepEqual(claude.out, ['a [manual] no queued message']);
});

test('messages subcommand relays queued messages as plain text under Claude Code', async () => {
  const logger = recordingLogger();
  await main(['messages', 'a', '--board', '/b.json', '--session', 's1'], {
    takePendingMessages: async () => [{ text: 'rebase please' }],
    stdin: ttyStdin(),
    logger,
  });
  assert.deepEqual(logger.out, ['[maggie] Message(s) sent from the board dashboard while you were away:\n- rebase please']);
});

test('messages subcommand requires a repo', async () => {
  await assert.rejects(
    () => main(['messages', '--board', '/b.json'], { stdin: ttyStdin(), logger: silentLogger() }),
    /Usage: maggie-workspace messages <repo>/,
  );
});

test('session-end subcommand uses the Copilot usage reader and records the agent it was told about', async () => {
  const appendCalls = [];
  const logger = recordingLogger();
  await main(['session-end', 'a', '--board', '/b.json', '--agent', 'copilot'], {
    readBoard: async () => ({
      version: 2,
      repos: { a: { sessions: { 'cop-1': { status: 'question', title: 't', startedAt: 'T0', usage: null } } } },
    }),
    readTranscriptUsage: async () => { throw new Error('the Claude reader must not be used'); },
    readCopilotTranscriptUsage: async () => ({ inputTokens: 3, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
    appendHistoryEntry: async (_hp, entry) => appendCalls.push(entry),
    removeSession: async () => {},
    now: () => 'T2',
    stdin: pipedStdin({ sessionId: 'cop-1', reason: 'user_exit', transcriptPath: '/e.jsonl' }),
    logger,
  });
  assert.equal(appendCalls[0].agent, 'copilot');
  assert.equal(appendCalls[0].usage.inputTokens, 3);
  assert.deepEqual(logger.out, []);
  assert.deepEqual(logger.err, ['a [cop-1] session ended']);
});

test('an unknown agent is rejected by every hook-facing subcommand', async () => {
  for (const argv of [
    ['status', 'a', 'done', '--board', '/b.json', '--agent', 'cursor'],
    ['messages', 'a', '--board', '/b.json', '--agent', 'cursor'],
    ['session-end', 'a', '--board', '/b.json', '--agent', 'cursor'],
  ]) {
    await assert.rejects(
      () => main(argv, { stdin: ttyStdin(), logger: silentLogger() }),
      /Unknown agent "cursor" \(known: claude, copilot\)/,
    );
  }
});

test('--agent copilot reaches bootstrap and defaults the launch command to copilot', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws', '--agent', 'copilot'], {
    loadConfig: async () => config,
    runBootstrap: async (_c, opts) => { received = opts; return {}; },
    isInteractive: false,
    logger: silentLogger(),
  });
  assert.equal(received.agent, 'copilot');
  assert.equal(received.editor, 'copilot');
});

test('--editor still wins over the agent default when both are given', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws', '--agent', 'copilot', '--editor', 'vscode'], {
    loadConfig: async () => config,
    runBootstrap: async (_c, opts) => { received = opts; return {}; },
    isInteractive: false,
    logger: silentLogger(),
  });
  assert.equal(received.agent, 'copilot');
  assert.equal(received.editor, 'vscode');
});

test('bootstrap defaults to the claude agent when --agent is omitted', async () => {
  let received;
  await main(['--config', 'repos.json', '--workspace', '/tmp/ws'], {
    loadConfig: async () => config,
    runBootstrap: async (_c, opts) => { received = opts; return {}; },
    isInteractive: false,
    logger: silentLogger(),
  });
  assert.equal(received.agent, 'claude');
  assert.equal(received.editor, 'claude');
});
