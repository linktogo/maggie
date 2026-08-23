import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadConfigFromRepo, resolveConfigSource } from '@linktogo/maggie-config';
import { reconcileHooks, resolveHistoryPath, closeSession, queueMessage } from '@linktogo/maggie-workspace-bootstrap';
import { createCiReader } from './ciReader.js';

// Resolve the board file the server should read. Explicit --board and the
// AI_SYNC_BOARD env var always win; otherwise auto-detect the workspace board
// (`wk/.maggie/board.json`, where bootstrap's hooks write) so `npm start` with
// no flags "just works" instead of reading an empty `./board.json`.
export function resolveServerBoardPath({
  board,
  env = process.env,
  cwd = process.cwd(),
  exists = existsSync,
} = {}) {
  if (board) return path.resolve(cwd, board);
  if (env.AI_SYNC_BOARD) return path.resolve(cwd, env.AI_SYNC_BOARD);
  const workspaceBoard = path.resolve(cwd, 'wk', '.maggie', 'board.json');
  if (exists(workspaceBoard)) return workspaceBoard;
  return path.resolve(cwd, 'board.json');
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function serveBoard(boardPath, res) {
  let body;
  try {
    body = await readFile(boardPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    body = JSON.stringify({ version: 2, repos: {} });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

async function serveHistory(historyPath, res) {
  let raw;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    raw = '';
  }
  const entries = raw.split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry !== null);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(entries));
}

function serveConfig(config, res) {
  const repos = {};
  for (const r of config?.repos ?? []) {
    repos[r.name] = { url: r.url, technologies: r.technologies, targets: r.targets };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ repos }));
}

function repoNamesFromConfig(config) {
  if (!config) return null;
  return (config.repos ?? []).map((r) => r?.name).filter(Boolean);
}

async function serveCi(ciReader, config, res) {
  const body = ciReader
    ? await ciReader.read(repoNamesFromConfig(config))
    : { generatedAt: new Date().toISOString(), lastSyncError: 'status repo not configured', repos: {} };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJSONBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveCloseSession(boardPath, req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const { repo, sessionId } = body ?? {};
  if (!repo || !sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'repo and sessionId are required' }));
    return;
  }
  const result = await closeSession(boardPath, repo, sessionId);
  res.writeHead(result.closed ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function serveQueueMessage(boardPath, req, res) {
  let body;
  try {
    body = await readJSONBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }
  const { repo, sessionId } = body ?? {};
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!repo || !sessionId || !message) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'repo, sessionId and a non-empty message are required' }));
    return;
  }
  const result = await queueMessage(boardPath, repo, sessionId, message);
  res.writeHead(result.queued ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function serveStatic(distDir, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(distDir, rel);
  if (!file.startsWith(path.resolve(distDir))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // SPA fallback: serve index.html for unknown routes
    const index = await readFile(path.join(distDir, 'index.html')).catch(() => null);
    if (index) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(index); }
    else { res.writeHead(404); res.end('not found'); }
  }
}

export function createBoardServer({ boardPath, distDir, config = null, ciReader = null }) {
  const historyPath = resolveHistoryPath(boardPath);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/board') return await serveBoard(boardPath, res);
      if (url.pathname === '/api/history') return await serveHistory(historyPath, res);
      if (url.pathname === '/api/config') return serveConfig(config, res);
      if (url.pathname === '/api/ci') return await serveCi(ciReader, config, res);
      if (url.pathname === '/api/sessions/close' && req.method === 'POST') return await serveCloseSession(boardPath, req, res);
      if (url.pathname === '/api/sessions/message' && req.method === 'POST') return await serveQueueMessage(boardPath, req, res);
      return await serveStatic(distDir, url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
}

export async function startFromArgv(argv, {
  log = console.log,
  loadConfig: loadConfigDep = loadConfig,
  loadConfigFromRepo: loadConfigFromRepoDep = loadConfigFromRepo,
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      board: { type: 'string' }, port: { type: 'string', default: '4180' },
      dist: { type: 'string' }, config: { type: 'string' },
      'status-repo': { type: 'string' }, 'ci-interval': { type: 'string', default: '60' },
      'ci-state': { type: 'string' }, 'ci-cache': { type: 'string' },
      'config-repo': { type: 'string' }, 'config-file': { type: 'string' },
    },
  });
  const boardPath = resolveServerBoardPath({ board: values.board });
  const configSrc = values.config ?? process.env.AI_SYNC_CONFIG ?? null;
  const configRepo = values['config-repo'] ?? null;
  let config = null;
  if (configSrc || configRepo) {
    try {
      config = await resolveConfigSource(
        { config: configSrc ? path.resolve(configSrc) : null, configRepo, configFile: values['config-file'] },
        { loadConfig: loadConfigDep, loadConfigFromRepo: loadConfigFromRepoDep },
      );
      const hookCommand = fileURLToPath(new URL('../workspace/bin/workspace.js', import.meta.url));
      const results = await reconcileHooks(config, { boardPath, hookCommand });
      for (const r of results) {
        if (r.status === 'repointed') log(`  ✓ ${r.repo}: ${r.agent} hooks repointed`);
        else if (r.status === 'error') log(`  ⚠ ${r.repo}: ${r.error}`);
      }
      const upToDate = results.filter((r) => r.status === 'up-to-date').length;
      if (upToDate > 0 && !results.some((r) => r.status === 'repointed' || r.status === 'error')) {
        log(`  hooks verified for ${upToDate} repo(s), all up to date`);
      }
    } catch (err) {
      log(`  ⚠ hook reconciliation skipped: ${err.message}`);
    }
  }
  const boardDir = path.dirname(boardPath);
  const statusRepo = values['status-repo'] ?? process.env.AI_SYNC_STATUS_REPO ?? null;
  const ciReader = createCiReader({
    statusRepo,
    token: process.env.AI_SYNC_STATUS_TOKEN ?? null,
    stateFile: values['ci-state'] ? path.resolve(values['ci-state']) : path.join(boardDir, 'ci.json'),
    cacheDir: values['ci-cache'] ? path.resolve(values['ci-cache']) : path.join(boardDir, 'ci-status'),
    logger: { log, warn: log },
  });
  if (statusRepo) {
    log(`  ci status from ${statusRepo} (${values['ci-interval']}s)`);
    void ciReader.tick();
  }
  const distDir = values.dist ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
  const server = createBoardServer({ boardPath, distDir, config, ciReader });

  // Like the Angular CLI: if the port is taken, fall back to the next one.
  const maxAttempts = 10;
  let port = Number(values.port);
  let attempts = 1;
  const ciTimer = statusRepo ? setInterval(() => void ciReader.tick(), Number(values['ci-interval']) * 1000) : null;
  server.on('close', () => { if (ciTimer) clearInterval(ciTimer); });
  server.on('listening', () => log(`board on http://localhost:${port} (data: ${boardPath})`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts++ < maxAttempts) {
      log(`Port ${port} is already in use, trying ${port + 1}...`);
      port += 1;
      setTimeout(() => server.listen(port), 50);
    } else {
      throw err;
    }
  });
  server.listen(port);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startFromArgv(process.argv.slice(2));
}
