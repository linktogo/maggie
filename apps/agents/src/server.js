import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AgentError, listSkills } from '@linktogo/maggie-agent-runner';

// This server runs commands on the machine, so it answers loopback only, wants a
// bearer token on every request, and refuses any request carrying an Origin that
// was not explicitly allowed (a page in the browser can never reach it; the board
// talks to it from its own server, which sends no Origin).
export const LOOPBACK = '127.0.0.1';
export const DEFAULT_BODY_LIMIT = 1_000_000;
export const DEFAULT_HEARTBEAT_MS = 30_000;

const STATUS_BY_CODE = { invalid: 400, 'not-found': 404, busy: 409, 'too-large': 413 };
const THREAD_PATH = /^\/threads\/(th_[0-9a-f]{16})(\/messages|\/events|\/run)?$/;
const TERMINAL_PATH = /^\/terminals(?:\/(tm_[0-9a-f]{16})(\/events|\/input|\/resize)?)?$/;
const QUERY_PARAMS = ['repo', 'status', 'q', 'before'];
const DISABLED = 'the console is disabled (--no-terminal)';

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host) {
  return LOOPBACK_HOST.test(host ?? '');
}

export function isAuthorized(header, token) {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AgentError('too-large', 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentError('invalid', 'invalid JSON body');
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readObject(req, limit, shape) {
  return readJson(req, limit).then((body) => {
    if (!isObject(body)) throw new AgentError('invalid', `body must be ${shape}`);
    return body;
  });
}

// Pty output is raw bytes (a UTF-8 character may straddle two chunks): base64 keeps them intact.
const terminalSse = (event) => (event.type === 'data'
  ? `event: data\ndata: ${event.data.toString('base64')}\n\n`
  : `event: exit\ndata: ${JSON.stringify({ code: event.code, signal: event.signal })}\n\n`);

const sse = (event) => (event.type === 'message'
  ? `event: message\ndata: ${JSON.stringify(event.message)}\n\n`
  : `event: status\ndata: ${JSON.stringify({ status: event.status })}\n\n`);

export function createAgentsServer({
  token, threads, repos, skillsDir, providers, terminals = null, allowedOrigins = [], bodyLimit = DEFAULT_BODY_LIMIT, heartbeatMs = DEFAULT_HEARTBEAT_MS, log = () => {},
}) {
  // Narrates a thread on the server console: its run starts, then each status it reaches.
  function trace(thread) {
    log(`[${thread.id}] started on ${thread.repo} with ${thread.provider}${thread.model ? ` (${thread.model})` : ''}${thread.skill ? `, skill ${thread.skill}` : ''}`);
    let unsubscribe; // a thread that already settled calls back before subscribe returns
    unsubscribe = threads.subscribe(thread.id, (event) => {
      if (event.type !== 'status') return;
      log(`[${thread.id}] ${event.status}`);
      if (event.status !== 'running') unsubscribe?.();
    });
    return thread;
  }

  // With `after`, the messages stored past that id are replayed before the live
  // ones, in the same tick as the subscription (see threads.subscribe).
  function follow(res, id, after) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    let unsubscribe; // a thread that already settled calls back before subscribe returns
    unsubscribe = threads.subscribe(id, (event) => {
      res.write(sse(event));
      if (event.type === 'status' && event.status !== 'running') res.end();
    }, { after });
    res.on('close', unsubscribe);
  }

  function parseAfter(url) {
    const { searchParams } = new URL(url, 'http://localhost');
    if (!searchParams.has('after')) return undefined;
    const text = searchParams.get('after');
    if (!/^\d+$/.test(text)) throw new AgentError('invalid', 'after must be a non-negative integer (a message id)');
    return Number(text);
  }

  async function threadRoute(req, res, id, sub) {
    if (req.method === 'GET' && sub === '/events') {
      const after = parseAfter(req.url);
      if (!threads.get(id)) throw new AgentError('not-found', `unknown thread: ${id}`);
      return follow(res, id, after);
    }
    if (req.method === 'GET' && !sub) {
      const found = threads.get(id);
      if (!found) throw new AgentError('not-found', `unknown thread: ${id}`);
      return send(res, 200, found);
    }
    if (req.method === 'POST' && sub === '/messages') {
      return send(res, 202, { thread: trace(threads.reply(id, await readJson(req, bodyLimit))) });
    }
    if (req.method === 'DELETE' && sub === '/run') return send(res, 202, { thread: threads.stop(id) });
    if (req.method === 'PATCH' && !sub) {
      const body = await readJson(req, bodyLimit);
      const keys = body !== null && typeof body === 'object' ? Object.keys(body) : [];
      if (keys.length !== 1 || keys[0] !== 'status') throw new AgentError('invalid', 'body must be { status }');
      return send(res, 200, { thread: threads.setStatus(id, body.status) });
    }
    if (req.method === 'DELETE' && !sub) {
      threads.remove(id);
      res.writeHead(204);
      return res.end();
    }
    return send(res, 404, { error: 'not found' });
  }

  async function terminalRoute(req, res, id, sub) {
    if (!terminals) throw new AgentError('unavailable', DISABLED);
    if (!id && req.method === 'POST') {
      const { repo, cols, rows } = await readObject(req, bodyLimit, '{ repo, cols, rows }');
      return send(res, 201, { terminal: await terminals.open({ repo, cols, rows }) });
    }
    if (id && req.method === 'GET' && sub === '/events') {
      // Subscribe before the headers, so an unknown id is still a plain 404; what
      // the terminal replays during subscribe waits for the headers.
      const pending = [];
      let emit = (event) => pending.push(event);
      const unsubscribe = terminals.subscribe(id, (event) => emit(event));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      // A shell can stay silent for long: without traffic the board's relay (undici's
      // 300 s body timeout) would drop the stream, and the shell with it.
      const heartbeat = setInterval(() => res.write(':\n\n'), heartbeatMs);
      emit = (event) => {
        res.write(terminalSse(event));
        if (event.type !== 'exit') return;
        clearInterval(heartbeat); // never a write after end
        res.end();
      };
      pending.forEach(emit);
      res.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return undefined;
    }
    if (id && req.method === 'POST' && sub === '/input') {
      const body = await readObject(req, bodyLimit, '{ data }');
      if (typeof body.data !== 'string') throw new AgentError('invalid', 'body must be { data: string }');
      terminals.write(id, body.data);
    } else if (id && req.method === 'POST' && sub === '/resize') {
      const { cols, rows } = await readObject(req, bodyLimit, '{ cols, rows }');
      terminals.resize(id, cols, rows);
    } else if (id && req.method === 'DELETE' && !sub) {
      terminals.kill(id);
    } else {
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(204);
    return res.end();
  }

  async function terminalHealth() {
    if (!terminals) return { available: false, reason: 'disabled' };
    const { ok, reason } = await terminals.available();
    return ok ? { available: true } : { available: false, reason };
  }

  return createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const { pathname } = new URL(req.url, 'http://localhost');
      log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 403, { error: 'forbidden: only loopback hosts are served' });
      if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin)) {
        return send(res, 403, { error: 'forbidden: cross-site requests are not accepted' });
      }
      if (!isAuthorized(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized' });

      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, {
          providers: { available: providers.detect(), default: providers.defaultProvider },
          repos: repos.names(),
          terminal: await terminalHealth(),
        });
      }
      if (req.method === 'GET' && pathname === '/skills') return send(res, 200, { skills: listSkills(skillsDir) });
      if (req.method === 'GET' && pathname === '/projects') return send(res, 200, { projects: threads.projects() });
      if (pathname === '/threads' && req.method === 'GET') {
        const { searchParams } = new URL(req.url, 'http://localhost');
        const query = Object.fromEntries(QUERY_PARAMS.filter((key) => searchParams.has(key)).map((key) => [key, searchParams.get(key)]));
        return send(res, 200, { threads: threads.list(query) });
      }
      if (pathname === '/threads' && req.method === 'POST') {
        return send(res, 202, { thread: trace(threads.start(await readJson(req, bodyLimit))) });
      }

      const terminal = TERMINAL_PATH.exec(pathname);
      if (terminal) return await terminalRoute(req, res, terminal[1], terminal[2]);
      const match = THREAD_PATH.exec(pathname);
      if (match) return await threadRoute(req, res, match[1], match[2]);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AgentError && err.code === 'unavailable') return send(res, 503, { error: 'terminal-unavailable', detail: err.message });
      if (err instanceof AgentError) return send(res, STATUS_BY_CODE[err.code] ?? 500, { error: err.message });
      log(`error on ${req.method} ${req.url}: ${err.stack}`);
      return send(res, 500, { error: err.message });
    }
  });
}
