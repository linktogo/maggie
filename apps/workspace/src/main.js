import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigSource } from '@linktogo/maggie-config';
import {
  bootstrap,
  AGENTS,
  DEFAULT_AGENT,
  resolveBoardPath,
  readBoard as defaultReadBoard,
  setSessionStatus as defaultSetSessionStatus,
  removeSession as defaultRemoveSession,
  takePendingMessages as defaultTakePendingMessages,
  readTranscriptUsage as defaultReadTranscriptUsage,
  readCopilotTranscriptUsage as defaultReadCopilotTranscriptUsage,
  resolveHistoryPath,
  appendHistoryEntry as defaultAppendHistoryEntry,
} from '@linktogo/maggie-workspace-bootstrap';

const TITLE_MAX = 60;

// Claude Code names its hook events in PascalCase, Copilot CLI in camelCase.
// Hooks always pass the event through --event, so the CLI keys off that rather
// than off a payload field only one of the two formats carries.
const PROMPT_EVENTS = new Set(['UserPromptSubmit', 'userPromptSubmitted']);
const STOP_EVENTS = new Set(['Stop', 'agentStop']);

// The Copilot events whose stdout is fed back into the session as
// `additionalContext`. `userPromptSubmitted` is deliberately absent: Copilot
// drops the output of command hooks on that event, so queued dashboard
// messages have to ride in on a session start or a notification instead.
const COPILOT_DELIVERY_EVENTS = new Set(['sessionStart', 'notification']);

const MESSAGE_INTRO = 'Message(s) sent from the board dashboard while you were away:';

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function resolveAgent(value) {
  const agent = value ?? DEFAULT_AGENT;
  if (!AGENTS.includes(agent)) {
    throw new Error(`Unknown agent "${agent}" (known: ${AGENTS.join(', ')})`);
  }
  return agent;
}

async function readStdinJSON(stdin) {
  if (stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Both agents send the same facts under different key styles: Claude Code uses
// the snake_case shape, Copilot CLI camelCase (its PascalCase event aliases
// fall back to snake_case, so both are accepted here).
function normalizePayload(raw) {
  return {
    sessionId: raw.session_id ?? raw.sessionId ?? null,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : null,
    transcriptPath: raw.transcript_path ?? raw.transcriptPath ?? null,
  };
}

// Copilot parses a hook's stdout as JSON, so the human-readable line has to go
// to stderr there or it would corrupt the reply. Under Claude Code stdout is
// free-form text that lands in the conversation, and stays as it was.
function makeReporter(agent, logger) {
  return agent === 'copilot'
    ? (line) => logger.error(line)
    : (line) => logger.log(line);
}

function formatQueuedMessages(pending) {
  return `${MESSAGE_INTRO}\n${pending.map((m) => `- ${m.text}`).join('\n')}`;
}

// Relay drained messages back into the session: Claude Code appends a hook's
// stdout to the conversation verbatim, Copilot expects an `additionalContext`
// JSON object which it injects as a prepended user message.
function emitPendingMessages(agent, pending, logger) {
  if (pending.length === 0) return false;
  const body = formatQueuedMessages(pending);
  logger.log(agent === 'copilot' ? JSON.stringify({ additionalContext: `[maggie] ${body}` }) : `[maggie] ${body}`);
  return true;
}

export async function main(argv, deps = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'status') return runStatus(rest, deps);
  if (sub === 'session-end') return runSessionEnd(rest, deps);
  if (sub === 'messages') return runMessages(rest, deps);
  if (sub === 'bootstrap') return runBootstrapMain(rest, deps);
  return runBootstrapMain(argv, deps);
}

async function runStatus(argv, deps = {}) {
  const {
    setSessionStatus = defaultSetSessionStatus,
    takePendingMessages = defaultTakePendingMessages,
    readTranscriptUsage = defaultReadTranscriptUsage,
    readCopilotTranscriptUsage = defaultReadCopilotTranscriptUsage,
    logger = console,
    stdin = process.stdin,
  } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      board: { type: 'string' }, event: { type: 'string' }, session: { type: 'string' },
      worktree: { type: 'string' }, agent: { type: 'string' },
    },
  });
  const [repo, state] = positionals;
  if (!repo || !state) throw new Error('Usage: maggie-workspace status <repo> <state> [--board <path>] [--event <name>] [--session <id>] [--worktree <branch>] [--agent <claude|copilot>]');
  const agent = resolveAgent(values.agent);
  const report = makeReporter(agent, logger);
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = normalizePayload(await readStdinJSON(stdin));
  const sessionId = values.session ?? payload.sessionId ?? 'manual';
  const event = values.event ?? 'manual';
  const opts = { lastEvent: event, agent };
  if (values.worktree) opts.worktree = values.worktree;
  if (PROMPT_EVENTS.has(event) && payload.prompt !== null) {
    opts.title = truncate(payload.prompt, TITLE_MAX);
    opts.lastPrompt = payload.prompt;
  }
  if (STOP_EVENTS.has(event) && payload.transcriptPath !== null) {
    opts.usage = agent === 'copilot'
      ? await readCopilotTranscriptUsage(payload.transcriptPath)
      : await readTranscriptUsage(payload.transcriptPath);
  }
  await setSessionStatus(boardPath, repo, sessionId, state, opts);

  // Drain anything queued from the board dashboard on the events whose output
  // the agent feeds back into the session, so a session picks up what was sent
  // while it was away.
  const delivers = agent === 'copilot' ? COPILOT_DELIVERY_EVENTS.has(event) : PROMPT_EVENTS.has(event);
  if (delivers) {
    emitPendingMessages(agent, await takePendingMessages(boardPath, repo, sessionId), logger);
  }

  report(`${repo} [${sessionId}] → ${state}`);
  return 0;
}

// Delivery-only entry point, wired to Copilot's `sessionStart` hook: it drains
// the dashboard queue without touching the session's status, so resuming a
// session picks up messages before the first prompt of the new run.
async function runMessages(argv, deps = {}) {
  const {
    takePendingMessages = defaultTakePendingMessages,
    logger = console,
    stdin = process.stdin,
  } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' }, session: { type: 'string' }, agent: { type: 'string' } },
  });
  const [repo] = positionals;
  if (!repo) throw new Error('Usage: maggie-workspace messages <repo> [--board <path>] [--session <id>] [--agent <claude|copilot>]');
  const agent = resolveAgent(values.agent);
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = normalizePayload(await readStdinJSON(stdin));
  const sessionId = values.session ?? payload.sessionId ?? 'manual';
  const pending = await takePendingMessages(boardPath, repo, sessionId);
  if (!emitPendingMessages(agent, pending, logger)) {
    makeReporter(agent, logger)(`${repo} [${sessionId}] no queued message`);
  }
  return 0;
}

async function runSessionEnd(argv, deps = {}) {
  const {
    removeSession = defaultRemoveSession,
    readBoard = defaultReadBoard,
    readTranscriptUsage = defaultReadTranscriptUsage,
    readCopilotTranscriptUsage = defaultReadCopilotTranscriptUsage,
    appendHistoryEntry = defaultAppendHistoryEntry,
    now = () => new Date().toISOString(),
    logger = console,
    stdin = process.stdin,
  } = deps;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { board: { type: 'string' }, agent: { type: 'string' } },
  });
  const [repo] = positionals;
  if (!repo) throw new Error('Usage: maggie-workspace session-end <repo> [--board <path>] [--agent <claude|copilot>]');
  const agent = resolveAgent(values.agent);
  const report = makeReporter(agent, logger);
  const boardPath = resolveBoardPath({ board: values.board });
  const payload = normalizePayload(await readStdinJSON(stdin));
  const sessionId = payload.sessionId ?? 'manual';

  // Removing the session from the board is the load-bearing behavior here —
  // a failure recording token-usage history must never leave a zombie card
  // stuck on the board forever (SessionEnd only fires once).
  try {
    const board = await readBoard(boardPath);
    const session = board.repos[repo]?.sessions?.[sessionId];
    if (session) {
      const readUsage = agent === 'copilot' ? readCopilotTranscriptUsage : readTranscriptUsage;
      const usage = payload.transcriptPath !== null
        ? await readUsage(payload.transcriptPath)
        : session.usage ?? null;
      await appendHistoryEntry(resolveHistoryPath(boardPath), {
        repo,
        sessionId,
        title: session.title ?? null,
        agent: session.agent ?? agent,
        startedAt: session.startedAt ?? null,
        endedAt: now(),
        usage,
      });
    }
  } catch (err) {
    logger.warn(`${repo} [${sessionId}] failed to record token-usage history: ${err.message}`);
  }

  await removeSession(boardPath, repo, sessionId);
  report(`${repo} [${sessionId}] session ended`);
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
      agent: { type: 'string' },
      editor: { type: 'string' },
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

  // --agent picks which agent's hooks are installed; --editor only picks the
  // launch command that gets printed, and defaults to the agent so
  // `--agent copilot` alone prints a `copilot` command.
  const agent = resolveAgent(values.agent);

  // Without an explicit --repo, prompt for a single project to load when
  // running interactively; non-interactive runs keep bootstrapping every repo.
  let repoFilter = values.repo;
  if (!repoFilter && isInteractive) {
    repoFilter = await selectRepo(config.repos);
  }

  await runBootstrap(config, {
    workspaceDir: path.resolve(values.workspace),
    agent,
    editor: values.editor ?? agent,
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
