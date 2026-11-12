# Board Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Claude Code session's token consumption live on its board card, and keep a permanent history of every session's final usage once it ends, so past consumption can be reviewed after the session's card disappears.

**Architecture:** Every hook payload carries `transcript_path`, a local JSONL file where each assistant turn has a `message.usage` object. A new `tokens.js` module in `libs/workspace-bootstrap` sums those fields into `{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }`. The CLI (`ai-workspace status`) recomputes this on every `Stop` hook and stores it on the session's `board.json` entry (live, alongside `title`/`lastPrompt`). On `SessionEnd`, before the session is removed from `board.json`, the CLI appends one finalized record — repo, session id, title, start/end time, usage — to a new permanent `history.jsonl` file living next to `board.json`. The board server exposes it read-only at `GET /api/history`; the Vue front-end shows a live token badge on each session row and a new sortable/filterable history table.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`) for `libs/workspace-bootstrap`, `apps/workspace`, and `apps/board/server.js`; Vue 3 + Vitest + `@vue/test-utils` for `apps/board/src`. No new runtime dependencies.

**Reference:** Full rationale and decisions in `docs/superpowers/specs/2026-08-07-board-token-usage-design.md`. Builds on `docs/superpowers/specs/2026-08-05-board-multi-session-cards-design.md`.

---

## Lot 1 — Data & backend

### Task 1: Token extraction module (`tokens.js`, new)

**Files:**
- Create: `libs/workspace-bootstrap/src/tokens.js`
- Modify: `libs/workspace-bootstrap/src/index.js`
- Test: `libs/workspace-bootstrap/test/tokens.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `libs/workspace-bootstrap/test/tokens.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readTranscriptUsage, resolveHistoryPath, appendHistoryEntry } from '../src/tokens.js';

test('readTranscriptUsage sums usage across assistant lines, including sidechain turns', async () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 22, cacheCreationInputTokens: 33, cacheReadInputTokens: 44 });
});

test('readTranscriptUsage skips non-assistant lines and assistant lines without usage', async () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  ].join('\n') + '\n';
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
});

test('readTranscriptUsage skips malformed JSON lines and blank lines', async () => {
  const lines = [
    '{not json',
    '',
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } } }),
  ].join('\n');
  const usage = await readTranscriptUsage('/t.jsonl', { read: async () => lines });
  assert.deepEqual(usage, { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 });
});

test('readTranscriptUsage returns zeroed totals when the file cannot be read', async () => {
  const usage = await readTranscriptUsage('/missing.jsonl', { read: async () => { throw new Error('ENOENT'); } });
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
});

test('resolveHistoryPath derives history.jsonl next to the board file', () => {
  assert.equal(resolveHistoryPath('/ws/.ai-sync/board.json'), path.join('/ws/.ai-sync', 'history.jsonl'));
});

test('appendHistoryEntry ensures the directory and appends one JSON line per call', async () => {
  const calls = [];
  await appendHistoryEntry('/d/history.jsonl', { a: 1 }, {
    ensureDir: async (dir, opts) => calls.push(['ensureDir', dir, opts]),
    append: async (file, data) => calls.push(['append', file, data]),
  });
  assert.deepEqual(calls, [
    ['ensureDir', '/d', { recursive: true }],
    ['append', '/d/history.jsonl', '{"a":1}\n'],
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace-bootstrap`
Expected: FAIL — `libs/workspace-bootstrap/src/tokens.js` does not exist yet.

- [ ] **Step 3: Implement `tokens.js`**

Create `libs/workspace-bootstrap/src/tokens.js`:

```js
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

// Every Claude Code hook payload carries transcript_path, a local JSONL file
// where each assistant turn has a message.usage object. board.json never
// gets token counts from the hook payload itself — this is the only source.
export async function readTranscriptUsage(transcriptPath, { read = readFile } = {}) {
  let raw;
  try {
    raw = await read(transcriptPath, 'utf8');
  } catch {
    return { ...EMPTY_USAGE };
  }
  const totals = { ...EMPTY_USAGE };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) continue;
    totals.inputTokens += usage.input_tokens ?? 0;
    totals.outputTokens += usage.output_tokens ?? 0;
    totals.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    totals.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  }
  return totals;
}

export function resolveHistoryPath(boardPath) {
  return path.join(path.dirname(boardPath), 'history.jsonl');
}

export async function appendHistoryEntry(historyPath, entry, opts = {}) {
  const { append = appendFile, ensureDir = mkdir } = opts;
  await ensureDir(path.dirname(historyPath), { recursive: true });
  await append(historyPath, `${JSON.stringify(entry)}\n`);
}
```

- [ ] **Step 4: Export the new functions from the package**

In `libs/workspace-bootstrap/src/index.js`, add a new export line (leave the existing three lines untouched):

```js
export { bootstrap, formatTimestamp } from './bootstrap.js';
export { resolveBoardPath, setSessionStatus, removeSession } from './board.js';
export { reconcileHooks } from './reconcile.js';
export { readTranscriptUsage, resolveHistoryPath, appendHistoryEntry } from './tokens.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, 100% coverage (lines/functions/branches) on `libs/workspace-bootstrap/src/tokens.js`.

- [ ] **Step 6: Commit**

```bash
git add libs/workspace-bootstrap/src/tokens.js libs/workspace-bootstrap/src/index.js libs/workspace-bootstrap/test/tokens.test.js
git commit -m "feat(workspace): extract token usage from Claude Code transcripts"
```

---

### Task 2: `startedAt`/`usage` on board sessions (`board.js`)

**Files:**
- Modify: `libs/workspace-bootstrap/src/board.js`
- Modify: `libs/workspace-bootstrap/src/index.js`
- Modify: `libs/workspace-bootstrap/README.md`
- Test: `libs/workspace-bootstrap/test/board.test.js`

- [ ] **Step 1: Write the failing tests**

In `libs/workspace-bootstrap/test/board.test.js`, update the first `setSessionStatus` test's expected object (it does a full `deepEqual`, so it must include the two new fields):

```js
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
    usage: null,
    events: [{ event: 'Notification', at: '2026-06-16T10:00:00Z' }],
  });
});
```

Then add two new tests directly after the existing `'setSessionStatus overwrites lastPrompt when passed and preserves the previous value when omitted'` test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace-bootstrap`
Expected: FAIL — the updated exhaustive `deepEqual` is missing `startedAt`/`usage` from the actual output, and the two new tests find `startedAt: undefined` / `usage: undefined`.

- [ ] **Step 3: Update `setSessionStatus` in `board.js`**

In `libs/workspace-bootstrap/src/board.js`, replace the `setSessionStatus` function:

```js
export async function setSessionStatus(boardPath, repo, sessionId, state, opts = {}) {
  const {
    lastEvent = 'manual', title, lastPrompt, usage, startedAt,
    now = () => new Date().toISOString(), ...io
  } = opts;
  if (!STATES.includes(state)) {
    throw new Error(`Invalid state "${state}" (valid: ${STATES.join(', ')})`);
  }
  const board = await readBoard(boardPath, io);
  const at = now();
  const repoEntry = board.repos[repo] ?? { sessions: {} };
  const prevSession = repoEntry.sessions[sessionId];
  const events = [{ event: lastEvent, at }, ...(prevSession?.events ?? [])].slice(0, MAX_EVENTS);
  repoEntry.sessions[sessionId] = {
    status: state,
    updatedAt: at,
    lastEvent,
    title: prevSession?.title ?? title ?? null,
    lastPrompt: lastPrompt ?? prevSession?.lastPrompt ?? null,
    startedAt: prevSession?.startedAt ?? startedAt ?? at,
    usage: usage ?? prevSession?.usage ?? null,
    events,
  };
  board.repos[repo] = repoEntry;
  await writeBoard(boardPath, board, io);
  return board;
}
```

Everything else in `board.js` (`resolveBoardPath`, `normalizeRepoEntry`, `readBoard`, `writeBoard`, `removeSession`, `initRepos`) is unchanged.

- [ ] **Step 4: Export `readBoard` (needed by the CLI in Task 3) and update the README**

In `libs/workspace-bootstrap/src/index.js`, widen the board export line:

```js
export { resolveBoardPath, readBoard, setSessionStatus, removeSession } from './board.js';
```

In `libs/workspace-bootstrap/README.md`, append a short paragraph after the existing "Board states are..." paragraph:

```markdown
Each session also tracks `startedAt` (set once) and `usage` — an
`{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }`
object recomputed from the session's transcript on every `Stop` event, kept
`null` until the first one. See `tokens.js` for the transcript-parsing and
`history.jsonl` helpers.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx nx test workspace-bootstrap`
Expected: PASS, 100% coverage on `libs/workspace-bootstrap/src/board.js`.

- [ ] **Step 6: Commit**

```bash
git add libs/workspace-bootstrap/src/board.js libs/workspace-bootstrap/src/index.js libs/workspace-bootstrap/README.md libs/workspace-bootstrap/test/board.test.js
git commit -m "feat(workspace): track startedAt and live token usage on board sessions"
```

---

### Task 3: CLI wiring — compute usage on `Stop`, write history on `SessionEnd` (`apps/workspace/src/main.js`)

**Files:**
- Modify: `apps/workspace/src/main.js`
- Test: `apps/workspace/test/main.test.js`

- [ ] **Step 1: Write the failing tests**

In `apps/workspace/test/main.test.js`, add the import for `resolveHistoryPath` (used to compute the expected history path in the new tests) next to the existing imports:

```js
import { resolveHistoryPath } from '@linktogo/ai-workspace-bootstrap';
```

Update the two existing `session-end` tests that don't currently mock `readBoard` — they'll otherwise hit the real filesystem once `runSessionEnd` starts reading the board. Replace:

```js
test('main routes the session-end subcommand to removeSession using the piped session id', async () => {
  const calls = [];
  const code = await main(['session-end', 'oc-be', '--board', '/b.json'], {
    removeSession: async (boardPath, repo, sessionId) => { calls.push({ boardPath, repo, sessionId }); },
    stdin: pipedStdin({ session_id: 'sess-1', hook_event_name: 'SessionEnd', source: 'other' }),
    logger: silentLogger(),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ boardPath: path.resolve('/b.json'), repo: 'oc-be', sessionId: 'sess-1' }]);
});
```

with:

```js
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
```

And replace:

```js
test('session-end subcommand falls back to a "manual" session on a TTY', async () => {
  let receivedSessionId;
  await main(['session-end', 'a', '--board', '/b.json'], {
    removeSession: async (_p, _r, sessionId) => { receivedSessionId = sessionId; },
    stdin: ttyStdin(),
    logger: silentLogger(),
  });
  assert.equal(receivedSessionId, 'manual');
});
```

with:

```js
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
```

Then add five new tests. Two after the existing `'status subcommand does not forward a title/lastPrompt on Notification or Stop'` test:

```js
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
  assert.deepEqual(received, { lastEvent: 'Stop', usage });
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
```

And three after the (now-updated) `'session-end subcommand falls back to a "manual" session on a TTY'` test:

```js
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
    entry: { repo: 'oc-be', sessionId: 'sess-1', title: 'fix login', startedAt: 'T0', endedAt: '2026-06-16T12:00:00Z', usage },
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx nx test workspace`
Expected: FAIL — `runStatus` never calls `readTranscriptUsage`, and `runSessionEnd` never calls `readBoard`/`appendHistoryEntry`.

- [ ] **Step 3: Implement the CLI changes**

Replace `apps/workspace/src/main.js`:

```js
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigSource } from '@linktogo/ai-config';
import {
  bootstrap,
  resolveBoardPath,
  readBoard as defaultReadBoard,
  setSessionStatus as defaultSetSessionStatus,
  removeSession as defaultRemoveSession,
  readTranscriptUsage as defaultReadTranscriptUsage,
  resolveHistoryPath,
  appendHistoryEntry as defaultAppendHistoryEntry,
} from '@linktogo/ai-workspace-bootstrap';

const TITLE_MAX = 60;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function readStdinJSON(stdin) {
  if (stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function main(argv, deps = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'status') return runStatus(rest, deps);
  if (sub === 'session-end') return runSessionEnd(rest, deps);
  if (sub === 'bootstrap') return runBootstrapMain(rest, deps);
  return runBootstrapMain(argv, deps);
}

async function runStatus(argv, deps = {}) {
  const {
    setSessionStatus = defaultSetSessionStatus,
    readTranscriptUsage = defaultReadTranscriptUsage,
    logger = console,
    stdin = process.stdin,
  } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' }, event: { type: 'string' } },
  });
  const [repo, state] = positionals;
  if (!repo || !state) throw new Error('Usage: ai-workspace status <repo> <state> [--board <path>] [--event <name>]');
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = await readStdinJSON(stdin);
  const sessionId = payload.session_id ?? 'manual';
  const opts = { lastEvent: values.event ?? 'manual' };
  if (payload.hook_event_name === 'UserPromptSubmit' && typeof payload.prompt === 'string') {
    opts.title = truncate(payload.prompt, TITLE_MAX);
    opts.lastPrompt = payload.prompt;
  }
  if (payload.hook_event_name === 'Stop' && typeof payload.transcript_path === 'string') {
    opts.usage = await readTranscriptUsage(payload.transcript_path);
  }
  await setSessionStatus(boardPath, repo, sessionId, state, opts);
  logger.log(`${repo} [${sessionId}] → ${state}`);
  return 0;
}

async function runSessionEnd(argv, deps = {}) {
  const {
    removeSession = defaultRemoveSession,
    readBoard = defaultReadBoard,
    readTranscriptUsage = defaultReadTranscriptUsage,
    appendHistoryEntry = defaultAppendHistoryEntry,
    now = () => new Date().toISOString(),
    logger = console,
    stdin = process.stdin,
  } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' } },
  });
  const [repo] = positionals;
  if (!repo) throw new Error('Usage: ai-workspace session-end <repo> [--board <path>]');
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = await readStdinJSON(stdin);
  const sessionId = payload.session_id ?? 'manual';

  const board = await readBoard(boardPath);
  const session = board.repos[repo]?.sessions?.[sessionId];
  if (session) {
    const usage = typeof payload.transcript_path === 'string'
      ? await readTranscriptUsage(payload.transcript_path)
      : session.usage ?? null;
    await appendHistoryEntry(resolveHistoryPath(boardPath), {
      repo,
      sessionId,
      title: session.title ?? null,
      startedAt: session.startedAt ?? null,
      endedAt: now(),
      usage,
    });
  }

  await removeSession(boardPath, repo, sessionId);
  logger.log(`${repo} [${sessionId}] session ended`);
  return 0;
}

async function runBootstrapMain(argv, deps = {}) {
  const {
    loadConfig,
    loadConfigFromRepo,
    runBootstrap = bootstrap,
    selectRepo,
    onExisting,
    isInteractive = process.stdin.isTTY,
    logger = console,
  } = deps;

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      'config-repo': { type: 'string' },
      'config-file': { type: 'string' },
      workspace: { type: 'string' },
      editor: { type: 'string', default: 'claude' },
      repo: { type: 'string' },
      worktree: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
    },
  });

  const config = await resolveConfigSource(
    { config: values.config, configRepo: values['config-repo'], configFile: values['config-file'] },
    { loadConfig, loadConfigFromRepo },
  );
  if (!values.workspace) throw new Error('Missing required --workspace <dir>');

  let repoFilter = values.repo;
  if (!repoFilter && isInteractive) {
    repoFilter = await selectRepo(config.repos);
  }

  await runBootstrap(config, {
    workspaceDir: path.resolve(values.workspace),
    editor: values.editor,
    repoFilter,
    worktree: values.worktree,
    install: !values['no-install'],
    dryRun: values['dry-run'],
    offline: values.offline,
    onExisting: isInteractive ? onExisting : undefined,
    hookCommand: fileURLToPath(new URL('../bin/workspace.js', import.meta.url)),
    logger,
  });

  return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test workspace`
Expected: PASS, 100% coverage (lines/functions/branches) on `apps/workspace/src/main.js`.

- [ ] **Step 5: Commit**

```bash
git add apps/workspace/src/main.js apps/workspace/test/main.test.js
git commit -m "feat(workspace): compute live usage on Stop and record history on SessionEnd"
```

---

### Task 4: `GET /api/history` (`apps/board/server.js`)

**Files:**
- Modify: `apps/board/server.js`
- Test: `apps/board/server.test.js`

- [ ] **Step 1: Write the failing tests**

In `apps/board/server.test.js`, add two tests after the existing `'GET /api/board returns an empty board when the file is missing'` test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:board`
Expected: FAIL — `/api/history` isn't routed yet, so `serveStatic` handles it and returns a 404/SPA fallback instead of JSON.

- [ ] **Step 3: Add the route**

In `apps/board/server.js`, add `resolveHistoryPath` to the import from `@linktogo/ai-workspace-bootstrap`:

```js
import { reconcileHooks, resolveHistoryPath } from '@linktogo/ai-workspace-bootstrap';
```

Add a new function after `serveBoard`:

```js
async function serveHistory(historyPath, res) {
  let raw;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    raw = '';
  }
  const entries = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(entries));
}
```

Update `createBoardServer` to resolve the history path once and route to it:

```js
export function createBoardServer({ boardPath, distDir, config = null }) {
  const historyPath = resolveHistoryPath(boardPath);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      if (url.pathname === '/api/history') return await serveHistory(historyPath, res);
      if (url.pathname === '/api/config') return serveConfig(config, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}
```

Nothing else in `server.js` changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS, full suite (server + front-end) green.

- [ ] **Step 5: Commit**

```bash
git add apps/board/server.js apps/board/server.test.js
git commit -m "feat(board): serve the token usage history at GET /api/history"
```

---

## Lot 2 — Frontend (`apps/board/src`)

### Task 5: `formatTokens.js` (new)

**Files:**
- Create: `apps/board/src/formatTokens.js`
- Test: `apps/board/src/formatTokens.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/board/src/formatTokens.test.js`:

```js
import { test, expect } from 'vitest';
import { formatTokens } from './formatTokens.js';

test('formats sub-1000 values as-is', () => {
  expect(formatTokens(0)).toBe('0');
  expect(formatTokens(999)).toBe('999');
});

test('formats thousands with one decimal and a K suffix', () => {
  expect(formatTokens(1000)).toBe('1.0K');
  expect(formatTokens(36420)).toBe('36.4K');
});

test('formats millions with one decimal and an M suffix', () => {
  expect(formatTokens(1_200_000)).toBe('1.2M');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:board`
Expected: FAIL — `formatTokens.js` doesn't exist yet.

- [ ] **Step 3: Implement `formatTokens.js`**

Create `apps/board/src/formatTokens.js`:

```js
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/formatTokens.js apps/board/src/formatTokens.test.js
git commit -m "feat(board): add a compact token-count formatter"
```

---

### Task 6: Token badge on `SessionRow.vue`

**Files:**
- Modify: `apps/board/src/SessionRow.vue`
- Test: `apps/board/src/SessionRow.test.js`

- [ ] **Step 1: Write the failing tests**

In `apps/board/src/SessionRow.test.js`, add three tests after the existing `'emits "open" with the session id on click'` test:

```js
test('shows a token badge with the formatted total when usage is present', () => {
  const w = mount(SessionRow, {
    props: {
      session: session({ usage: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 300, cacheReadInputTokens: 36000 } }),
      now,
    },
  });
  expect(w.get('[data-test=token-badge]').text()).toContain('36.6K tokens');
});

test('does not show a token badge when usage is absent', () => {
  const w = mount(SessionRow, { props: { session: session(), now } });
  expect(w.find('[data-test=token-badge]').exists()).toBe(false);
});

test('the token badge tooltip breaks down usage by type', () => {
  const w = mount(SessionRow, {
    props: {
      session: session({ usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 } }),
      now,
    },
  });
  expect(w.get('[data-test=token-badge]').attributes('title')).toBe('input 1 · output 2 · cache écrit 3 · cache lu 4');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:board`
Expected: FAIL — `SessionRow.vue` has no `[data-test=token-badge]` element yet.

- [ ] **Step 3: Add the badge to `SessionRow.vue`**

Replace `apps/board/src/SessionRow.vue`:

```vue
<script setup>
import { ref, computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import { formatTokens } from './formatTokens.js';

const PROMPT_CLIP = 140;

const props = defineProps({
  session: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open']);

const expanded = ref(false);
const when = computed(() => relativeTime(props.session.updatedAt, props.now));
const prompt = computed(() => props.session.lastPrompt ?? '');
const overflows = computed(() => prompt.value.length > PROMPT_CLIP);
const displayedPrompt = computed(() => (
  expanded.value || !overflows.value ? prompt.value : `${prompt.value.slice(0, PROMPT_CLIP)}…`
));

const usage = computed(() => props.session.usage ?? null);
const totalTokens = computed(() => {
  if (!usage.value) return 0;
  const u = usage.value;
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
});
const usageTooltip = computed(() => {
  if (!usage.value) return '';
  const u = usage.value;
  return `input ${u.inputTokens} · output ${u.outputTokens} · cache écrit ${u.cacheCreationInputTokens} · cache lu ${u.cacheReadInputTokens}`;
});

function open() { emit('open', props.session.sessionId); }
function toggle(e) { e.stopPropagation(); expanded.value = !expanded.value; }
</script>

<template>
  <div
    role="button"
    tabindex="0"
    data-test="session-row"
    class="py-1.5 cursor-pointer"
    @click="open"
    @keydown.enter="open"
    @keydown.space.prevent="open"
  >
    <div class="font-medium text-slate-800 text-sm truncate">{{ session.title ?? '(sans titre)' }}</div>
    <div class="text-xs text-slate-500">
      {{ session.lastEvent }} · {{ when }}
      <span v-if="usage" data-test="token-badge" :title="usageTooltip" class="ml-1 text-slate-400">· {{ formatTokens(totalTokens) }} tokens</span>
    </div>
    <p v-if="prompt" class="mt-1 text-xs text-slate-600 whitespace-pre-wrap">
      {{ displayedPrompt }}
      <button
        v-if="overflows"
        type="button"
        data-test="toggle-prompt"
        class="text-blue-600 hover:underline"
        @click="toggle"
      >{{ expanded ? 'voir moins' : 'voir plus' }}</button>
    </p>
  </div>
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/SessionRow.vue apps/board/src/SessionRow.test.js
git commit -m "feat(board): show a live token badge on each session row"
```

---

### Task 7: `useHistory.js` (new)

**Files:**
- Create: `apps/board/src/useHistory.js`
- Test: `apps/board/src/useHistory.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/board/src/useHistory.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { useHistory } from './useHistory.js';

test('useHistory fetches immediately and exposes entries', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ([{ repo: 'a', sessionId: 's1' }]) });
  const { entries } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/history');
  expect(entries.value).toEqual([{ repo: 'a', sessionId: 's1' }]);
});

test('useHistory falls back to an empty list on a fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { entries } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(entries.value).toEqual([]);
});

test('load() re-fetches on demand', async () => {
  const responses = [
    { json: async () => ([]) },
    { json: async () => ([{ repo: 'a', sessionId: 's1' }]) },
  ];
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
  const { entries, load } = useHistory({ fetchImpl });
  await Promise.resolve();
  await Promise.resolve();
  expect(entries.value).toEqual([]);
  await load();
  expect(entries.value).toEqual([{ repo: 'a', sessionId: 's1' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:board`
Expected: FAIL — `useHistory.js` doesn't exist yet.

- [ ] **Step 3: Implement `useHistory.js`**

Create `apps/board/src/useHistory.js`:

```js
import { ref } from 'vue';

export function useHistory({ fetchImpl = fetch } = {}) {
  const entries = ref([]);
  async function load() {
    try {
      const res = await fetchImpl('/api/history');
      entries.value = await res.json();
    } catch {
      entries.value = [];
    }
  }
  load();
  return { entries, load };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/useHistory.js apps/board/src/useHistory.test.js
git commit -m "feat(board): add a useHistory composable for /api/history"
```

---

### Task 8: `HistoryView.vue` (new)

**Files:**
- Create: `apps/board/src/HistoryView.vue`
- Test: `apps/board/src/HistoryView.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/board/src/HistoryView.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryView from './HistoryView.vue';

function entry(overrides = {}) {
  return {
    repo: 'oc-be',
    sessionId: 's1',
    title: 'fix login',
    startedAt: '2026-06-21T09:00:00.000Z',
    endedAt: '2026-06-21T09:10:00.000Z',
    usage: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 300, cacheReadInputTokens: 400 },
    ...overrides,
  };
}

test('renders one row per entry', () => {
  const w = mount(HistoryView, { props: { entries: [entry(), entry({ sessionId: 's2', repo: 'other' })] } });
  expect(w.findAll('[data-test=history-row]')).toHaveLength(2);
});

test('shows a placeholder message when there are no entries', () => {
  const w = mount(HistoryView, { props: { entries: [] } });
  expect(w.text()).toContain('Aucune session terminée');
});

test('filtering by repo name hides non-matching rows', async () => {
  const w = mount(HistoryView, { props: { entries: [entry(), entry({ sessionId: 's2', repo: 'other' })] } });
  await w.get('[data-test=history-repo-filter]').setValue('oc-be');
  const rows = w.findAll('[data-test=history-row]');
  expect(rows).toHaveLength(1);
  expect(rows[0].text()).toContain('oc-be');
});

test('clicking a column header sorts rows, and clicking again reverses the order', async () => {
  const w = mount(HistoryView, {
    props: { entries: [entry({ repo: 'b', sessionId: 's1' }), entry({ repo: 'a', sessionId: 's2' })] },
  });
  await w.get('[data-test=sort-repo]').trigger('click');
  let rows = w.findAll('[data-test=history-row]');
  expect(rows[0].text()).toContain('a');
  await w.get('[data-test=sort-repo]').trigger('click');
  rows = w.findAll('[data-test=history-row]');
  expect(rows[0].text()).toContain('b');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:board`
Expected: FAIL — `HistoryView.vue` doesn't exist yet.

- [ ] **Step 3: Implement `HistoryView.vue`**

Create `apps/board/src/HistoryView.vue`:

```vue
<script setup>
import { ref, computed } from 'vue';
import { formatTokens } from './formatTokens.js';

const props = defineProps({
  entries: { type: Array, required: true },
});

const repoFilter = ref('');
const sortKey = ref('endedAt');
const sortDir = ref('desc');

function totalOf(entry) {
  const u = entry.usage ?? { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}

function durationLabel(entry) {
  if (!entry.startedAt || !entry.endedAt) return '';
  const ms = new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime();
  return `${Math.max(0, Math.round(ms / 60000))} min`;
}

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

function valueFor(entry, key) {
  if (key === 'total') return totalOf(entry);
  return entry[key] ?? '';
}

const rows = computed(() => {
  const filtered = props.entries.filter(
    (e) => !repoFilter.value || e.repo.toLowerCase().includes(repoFilter.value.toLowerCase()),
  );
  return [...filtered].sort((a, b) => {
    const av = valueFor(a, sortKey.value);
    const bv = valueFor(b, sortKey.value);
    if (av < bv) return sortDir.value === 'asc' ? -1 : 1;
    if (av > bv) return sortDir.value === 'asc' ? 1 : -1;
    return 0;
  });
});
</script>

<template>
  <div class="bg-white border border-slate-200 rounded-lg p-4">
    <input
      data-test="history-repo-filter"
      v-model="repoFilter"
      placeholder="🔍 filtrer un repo…"
      class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white mb-3"
    />
    <table class="w-full text-sm text-left">
      <thead>
        <tr class="text-slate-500 border-b border-slate-200">
          <th class="py-1 pr-3 cursor-pointer" data-test="sort-repo" @click="sortBy('repo')">Repo</th>
          <th class="py-1 pr-3 cursor-pointer" data-test="sort-title" @click="sortBy('title')">Titre</th>
          <th class="py-1 pr-3">Démarrée</th>
          <th class="py-1 pr-3">Terminée</th>
          <th class="py-1 pr-3">Durée</th>
          <th class="py-1 pr-3 text-right">Input</th>
          <th class="py-1 pr-3 text-right">Output</th>
          <th class="py-1 pr-3 text-right">Cache écrit</th>
          <th class="py-1 pr-3 text-right">Cache lu</th>
          <th class="py-1 pr-3 text-right cursor-pointer" data-test="sort-total" @click="sortBy('total')">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in rows" :key="`${e.repo}-${e.sessionId}`" data-test="history-row" class="border-b border-slate-100">
          <td class="py-1 pr-3">{{ e.repo }}</td>
          <td class="py-1 pr-3">{{ e.title ?? '(sans titre)' }}</td>
          <td class="py-1 pr-3">{{ e.startedAt }}</td>
          <td class="py-1 pr-3">{{ e.endedAt }}</td>
          <td class="py-1 pr-3">{{ durationLabel(e) }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.inputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.outputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.cacheCreationInputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right">{{ e.usage?.cacheReadInputTokens ?? 0 }}</td>
          <td class="py-1 pr-3 text-right font-medium">{{ formatTokens(totalOf(e)) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="text-xs text-slate-400 mt-2">Aucune session terminée pour l'instant.</p>
  </div>
</template>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/board/src/HistoryView.vue apps/board/src/HistoryView.test.js
git commit -m "feat(board): add a sortable/filterable token usage history table"
```

---

### Task 9: Board/Historique toggle (`App.vue`) + changelog

**Files:**
- Modify: `apps/board/src/App.vue`
- Modify: `CHANGELOG.md`
- Test: `apps/board/src/App.test.js`

- [ ] **Step 1: Write the failing test**

In `apps/board/src/App.test.js`, add a test after the existing `'typing in the search filters the cards'` test:

```js
test('toggling to the Historique tab shows history entries instead of the board', async () => {
  const fetchImpl = vi.fn().mockImplementation((url) => {
    if (url === '/api/config') return Promise.resolve({ json: async () => ({ repos: {} }) });
    if (url === '/api/history') {
      return Promise.resolve({
        json: async () => ([{
          repo: 'oc-be', sessionId: 's1', title: 'fix login',
          startedAt: 'T0', endedAt: 'T1',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 },
        }]),
      });
    }
    return Promise.resolve({ json: async () => ({ version: 2, repos: {} }) });
  });
  const wrapper = mount(App, { props: { fetchImpl, intervalMs: 100000 } });
  await settle();
  await wrapper.get('[data-test=view-history]').trigger('click');
  await settle();
  expect(wrapper.find('section').exists()).toBe(false);
  expect(wrapper.text()).toContain('fix login');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:board`
Expected: FAIL — `App.vue` has no `[data-test=view-history]` element and never renders `HistoryView`.

- [ ] **Step 3: Wire the toggle into `App.vue`**

In `apps/board/src/App.vue`, add the two new imports next to the existing ones:

```js
import HistoryView from './HistoryView.vue';
import { useHistory } from './useHistory.js';
```

Add the composable call and the `view` ref right after the existing `useNotifications` line:

```js
const { permission, soundOn, requestPermission, toggleSound } = useNotifications(transitions, questionCount, {});
const { entries: historyEntries, load: loadHistory } = useHistory({ fetchImpl });
const view = ref('board');
```

Replace the `<template>` block:

```vue
<template>
  <main class="min-h-screen bg-slate-100 p-4">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-bold text-slate-800">ai-sync · workspace board</h1>
        <div class="flex items-center gap-1 text-sm">
          <button
            data-test="view-board"
            :class="view === 'board' ? 'font-semibold text-slate-800' : 'text-slate-400'"
            @click="view = 'board'"
          >Board</button>
          <span class="text-slate-300">·</span>
          <button
            data-test="view-history"
            :class="view === 'history' ? 'font-semibold text-slate-800' : 'text-slate-400'"
            @click="view = 'history'; loadHistory()"
          >Historique</button>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <FilterBar
          v-if="view === 'board'"
          :name="nameFilter" :tech="techFilter" :technologies="technologies"
          @update:name="nameFilter = $event" @update:tech="techFilter = $event"
        />
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 activer</button>
        <button
          class="border border-slate-300 rounded-md px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} son</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-amber-700">⚠ déconnecté — nouvelle tentative au prochain poll…</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-slate-500">Notifications bloquées par le navigateur.</p>

    <template v-if="view === 'board'">
      <SummaryHeader :repos="repos" />

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Column
          v-for="c in grouped" :key="c.status"
          :title="c.title" :status="c.status" :accent="c.accent" :entries="c.entries" :now="now"
          @open="selected = $event"
        />
      </div>

      <RepoDetail
        :name="selected?.name ?? null" :session="selectedSession" :meta="selectedMeta" :now="now"
        @close="selected = null"
      />
    </template>
    <HistoryView v-else :entries="historyEntries" />
  </main>
</template>
```

Nothing else in `App.vue` (`<script setup>` above the two added lines) changes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:board`
Expected: PASS, full suite green.

- [ ] **Step 5: Update the changelog**

In `CHANGELOG.md`, add a bullet under `## [Unreleased]` → `### Added` (after the existing `--config-repo` bullet):

```markdown
- The board now tracks each session's token usage (input/output/cache,
  recomputed live on every `Stop`) and keeps a permanent `history.jsonl`
  record of every session's final usage after it ends, browsable in a new
  "Historique" tab (`GET /api/history`).
```

- [ ] **Step 6: Commit**

```bash
git add apps/board/src/App.vue apps/board/src/App.test.js CHANGELOG.md
git commit -m "feat(board): add a Board/Historique toggle showing token usage history"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (extraction) → Task 1. Section 2 (`board.js`) → Task 2. Section 3 (CLI) → Task 3. Section 4 (server) → Task 4. Section 5 (frontend) → Tasks 5–9. Section 6 (testing) → each task's own test file, matching the spec's per-file breakdown.
- **Hermetic tests:** Task 3 updates the two pre-existing `session-end` tests to inject `readBoard` so they don't fall through to the real filesystem now that `runSessionEnd` reads the board before removing a session.
- **Type consistency:** `usage` is always `{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }` end-to-end — `tokens.js` produces it, `board.js` stores it, `main.js` forwards/reads it, `SessionRow.vue`/`HistoryView.vue` consume the same four keys. `resolveHistoryPath`/`appendHistoryEntry` names match between `tokens.js`, `index.js`, `main.js`, and `server.js`.
