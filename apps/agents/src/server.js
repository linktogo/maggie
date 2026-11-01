import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AgentError, TERMINAL, listSkills, loadSkill, resolveProvider,
} from '@linktogo/maggie-agent-runner';

// This server runs commands on the machine, so it answers loopback only, wants a
// bearer token on every request, and refuses any request carrying an Origin that
// was not explicitly allowed (a page in the browser can never reach it; the board
// talks to it from its own server, which sends no Origin).
export const LOOPBACK = '127.0.0.1';
export const DEFAULT_BODY_LIMIT = 1_000_000;

const STATUS_BY_CODE = { invalid: 400, 'not-found': 404, busy: 409, 'too-large': 413 };
const RUN_PATH = /^\/runs\/([\w-]+)(\/events)?$/;

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

const sse = (event) => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`;

export function createAgentsServer({
  token, manager, repos, skillsDir, providers, allowedOrigins = [], bodyLimit = DEFAULT_BODY_LIMIT,
}) {
  function startRun(body) {
    if (typeof body?.repo !== 'string') throw new AgentError('invalid', 'repo is required');
    const provider = resolveProvider({ requested: body.provider, fallback: providers.defaultProvider });
    const cwd = repos.resolve(body.repo);
    const skill = body.skill === undefined || body.skill === null ? null : loadSkill(skillsDir, body.skill);
    const run = manager.start({ repo: body.repo, cwd, provider, model: body.model, prompt: body.prompt, skill });
    return { id: run.id, run };
  }

  function follow(res, id) {
    if (!manager.get(id)) throw new AgentError('not-found', `unknown run: ${id}`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const unsubscribe = manager.subscribe(id, (event) => {
      res.write(sse(event));
      if (event.type === 'status' && TERMINAL.has(event.data.status)) res.end();
    });
    res.on('close', unsubscribe);
  }

  return createServer(async (req, res) => {
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
        });
      }
      if (req.method === 'GET' && pathname === '/skills') return send(res, 200, { skills: listSkills(skillsDir) });
      if (pathname === '/runs' && req.method === 'GET') return send(res, 200, { runs: manager.list() });
      if (pathname === '/runs' && req.method === 'POST') return send(res, 202, startRun(await readJson(req, bodyLimit)));

      const match = RUN_PATH.exec(pathname);
      if (match) {
        const [, id, events] = match;
        if (req.method === 'GET' && events) return follow(res, id);
        if (req.method === 'GET') {
          const run = manager.get(id);
          if (!run) throw new AgentError('not-found', `unknown run: ${id}`);
          return send(res, 200, { run });
        }
        if (req.method === 'DELETE' && !events) return send(res, 202, { run: manager.cancel(id) });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AgentError) return send(res, STATUS_BY_CODE[err.code] ?? 500, { error: err.message });
      return send(res, 500, { error: err.message });
    }
  });
}
