import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  loadConfig as defaultLoadConfig, loadConfigFromRepo as defaultLoadConfigFromRepo, resolveConfigSource,
} from '@lk/maggie-config';
import {
  DEFAULT_AGENT_PROVIDER, DEFAULT_MAX_ACTIVE, createRepoResolver, createRunManager, createTerminalManager, createWorktreeManager, createThreadService, createThreadStore, detectProviders, resolveProvider, trustDirectories, claudeStateFile,
} from '@lk/maggie-agent-runner';
import { LOOPBACK, createAgentsServer } from './server.js';

export const DEFAULT_PORT = 4318;

/**
 * The skills library shipped with the package (copied there by `prepack`), or, from a clone,
 * the one at the repository root.
 */
export function packagedSkillsDir(exists = existsSync, base = import.meta.url) {
  const bundled = fileURLToPath(new URL('../skills', base));
  return exists(bundled) ? bundled : fileURLToPath(new URL('../../../skills', base));
}

/** Where the board finds the token to talk to this server. */
export const defaultTokenFile = (home = os.homedir()) => path.join(home, '.maggie', 'agents.token');

/** Where the thread history lives. */
export const defaultDbFile = (home = os.homedir()) => path.join(home, '.maggie', 'factory.db');

/** Create a directory only the user can enter, unless it already exists. */
async function ensurePrivateDir(dir) {
  if (existsSync(dir)) return;
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
}

export function onProcessSignal(signals, handler, proc = process) {
  for (const signal of signals) proc.once(signal, handler);
}

function parseNumber(text, { integer = false, min, max = Infinity }) {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

/** Subdirectories of `dir`; a missing (or unreadable) directory has none. */
function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Reconcile the stored worktrees with the disk. A worktree removed by hand is forgotten
 * with its Claude session (the thread can no longer be resumed); a folder no thread knows is only reported.
 * Nothing is ever deleted.
 */
function reconcileWorktrees({ store, workspace, log }) {
  for (const { id, worktree } of store.listWorktrees()) {
    if (existsSync(worktree.path)) continue;
    store.updateThread(id, { worktree: null });
    log(`  [${id}] worktree missing, cleared`);
  }
  const known = new Set(store.listWorktrees().map(({ worktree }) => worktree.path));
  const root = path.join(workspace, '.worktrees');
  for (const repo of subdirs(root)) {
    for (const name of subdirs(path.join(root, repo))) {
      const dir = path.join(root, repo, name);
      if (!known.has(dir)) log(`  orphan worktree: ${dir}`);
    }
  }
}

export async function main(argv, {
  log = console.log,
  loadConfig = defaultLoadConfig,
  loadConfigFromRepo = defaultLoadConfigFromRepo,
  detect = detectProviders,
  env = process.env,
  home = os.homedir(),
  onSignal = onProcessSignal,
  openStore = createThreadStore,
  createTerminals = createTerminalManager,
  createWorktrees = createWorktreeManager,
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: String(DEFAULT_PORT) },
      provider: { type: 'string' },
      repos: { type: 'string' },
      'config-repo': { type: 'string' },
      'config-file': { type: 'string' },
      workspace: { type: 'string', default: 'wk' },
      skills: { type: 'string' },
      'allow-origin': { type: 'string', multiple: true, default: [] },
      'token-file': { type: 'string' },
      db: { type: 'string' },
      timeout: { type: 'string', default: '600' },
      'max-runs': { type: 'string', default: String(DEFAULT_MAX_ACTIVE) },
      'trust-repos': { type: 'boolean', default: false },
      'no-terminal': { type: 'boolean', default: false },
    },
  });
  const port = parseNumber(values.port, { integer: true, min: 0, max: 65535 });
  if (port === null) throw new Error(`Invalid --port: ${values.port}`);
  const timeoutSeconds = parseNumber(values.timeout, { min: Number.MIN_VALUE });
  if (timeoutSeconds === null) throw new Error(`Invalid --timeout: ${values.timeout} (seconds, > 0)`);
  const maxRuns = parseNumber(values['max-runs'], { integer: true, min: 1 });
  if (maxRuns === null) throw new Error(`Invalid --max-runs: ${values['max-runs']} (integer, >= 1)`);
  if (!values.repos && !values['config-repo']) throw new Error('Missing required --repos <repos.json> or --config-repo <url>');
  const defaultProvider = resolveProvider({
    requested: values.provider ?? env.MAGGIE_AGENT_PROVIDER,
    fallback: DEFAULT_AGENT_PROVIDER,
  });
  const skillsDir = path.resolve(values.skills ?? packagedSkillsDir());
  if (!existsSync(skillsDir)) throw new Error(`Skills directory not found: ${skillsDir}`);

  log(`loading config from ${values.repos ?? values['config-repo']}`);
  const config = await resolveConfigSource(
    { config: values.repos ? path.resolve(values.repos) : null, configRepo: values['config-repo'], configFile: values['config-file'] },
    { loadConfig, loadConfigFromRepo },
  );
  const workspace = path.resolve(values.workspace);
  const repos = createRepoResolver({ repos: config.repos, workspace });
  log(`  ${config.repos.length} repositories, workspace ${workspace}, skills ${skillsDir}`);
  if (values['trust-repos']) {
    const checkedOut = [];
    for (const name of repos.names()) {
      try {
        checkedOut.push(repos.resolve(name));
      } catch {
        // not checked out: nothing to trust yet
      }
    }
    const trusted = await trustDirectories(checkedOut, { file: claudeStateFile(home) });
    for (const dir of trusted) log(`  trusted for Claude Code: ${dir}`);
  }
  const manager = createRunManager({ timeoutMs: timeoutSeconds * 1000, maxActive: maxRuns });
  const terminals = values['no-terminal'] ? null : createTerminals({ repos, log });
  if (!terminals) log('  console disabled (--no-terminal)');

  const dbFile = path.resolve(values.db ?? defaultDbFile(home));
  let store;
  try {
    await ensurePrivateDir(path.dirname(dbFile));
    // It holds the conversation history: private before SQLite opens it (its
    // -wal and -shm files take the same rights), even if it existed already.
    await writeFile(dbFile, '', { flag: 'a', mode: 0o600 });
    await chmod(dbFile, 0o600);
    store = openStore({ path: dbFile });
  } catch (err) {
    throw new Error(`Could not open the factory database ${dbFile}: ${err.message}`, { cause: err });
  }
  const worktrees = createWorktrees({ workspace, log });
  // A new worktree is a new folder for Claude Code: trusted like the checkouts when asked to.
  const onWorktreeCreated = values['trust-repos']
    ? async (dir) => {
      await trustDirectories([dir], { file: claudeStateFile(home) });
      log(`  trusted for Claude Code: ${dir}`);
    }
    : null;
  const threads = createThreadService({ store, manager, repos, skillsDir, defaultProvider, worktrees, log, onWorktreeCreated });

  const token = randomBytes(32).toString('hex');
  const tokenFile = path.resolve(values['token-file'] ?? defaultTokenFile(home));

  const server = createAgentsServer({
    token,
    threads,
    repos,
    skillsDir,
    providers: { detect, defaultProvider },
    terminals,
    maxRuns,
    allowedOrigins: values['allow-origin'],
    log,
  });

  // Listen first: a start that fails (port taken) must never touch the token file
  // of the instance that is already running.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    store.close();
    throw err;
  }

  // Only once the port is ours: a second instance that fails to bind must not mark
  // the threads of the live one as interrupted. The token file is not written yet,
  // so the board cannot reach this server before the recovery is done.
  const recovered = store.recoverInterrupted();
  if (recovered > 0) log(`  recovered ${recovered} interrupted thread(s)`);
  reconcileWorktrees({ store, workspace, log });

  // The token never reaches a log or a command line: it lives in a 0600 file the
  // board reads, and goes away with the server.
  try {
    await ensurePrivateDir(path.dirname(tokenFile));
    await rm(tokenFile, { force: true });
    await writeFile(tokenFile, `${token}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(tokenFile, 0o600);
  } catch (err) {
    server.close();
    store.close();
    throw err;
  }

  server.on('close', () => {
    store.close();
    void rm(tokenFile, { force: true });
  });

  const installed = detect();
  log(`agents server on http://localhost:${server.address().port} (token: ${tokenFile})`);
  log(`  default provider ${defaultProvider}; installed: ${installed.length ? installed.join(', ') : 'none (claude / copilot not found on PATH)'}`);
  onSignal(['SIGINT', 'SIGTERM'], () => {
    terminals?.killAll();
    server.close();
    server.closeAllConnections();
  });
  return server;
}
