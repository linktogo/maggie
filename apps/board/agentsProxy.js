import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

export const DEFAULT_AGENTS_URL = 'http://127.0.0.1:4318';

/** Where `maggie-agents` writes the token it generated at startup. */
export const defaultTokenFile = (home = os.homedir()) => path.join(home, '.maggie', 'agents.token');

// The routes of apps/agents, nothing else: the proxy is not a way to reach arbitrary paths.
const ROUTE = /^\/(health|skills|runs(\/[\w-]+(\/events)?)?)$/;
const METHODS = new Set(['GET', 'POST', 'DELETE']);

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const unavailable = (res, detail) => reply(res, 503, { error: 'agents-unavailable', detail });

/** Largest request body relayed to the agents server (a prompt, not an upload). */
export const MAX_BODY_BYTES = 1_000_000;

class BodyTooLarge extends Error {}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Relays `/api/factory/*` to the agents server. The browser never holds the
 * token: it is read from its file here and added to the upstream request, and
 * nothing of the upstream response but its status and content type is passed
 * back. SSE responses are piped through unbuffered.
 */
export function createAgentsProxy({
  url = DEFAULT_AGENTS_URL, tokenFile = defaultTokenFile(), fetchImpl = fetch,
} = {}) {
  return async function proxy(req, res, pathname, search = '') {
    const route = pathname.replace(/^\/api\/factory/, '');
    if (!ROUTE.test(route)) return reply(res, 404, { error: 'unknown factory route' });
    if (!METHODS.has(req.method)) return reply(res, 405, { error: 'method not allowed' });

    let token;
    try {
      token = (await readFile(tokenFile, 'utf8')).trim();
    } catch {
      return unavailable(res, `no token at ${tokenFile}: is the agents server running?`);
    }

    let body;
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (err) {
        if (err instanceof BodyTooLarge) return reply(res, 413, { error: 'request body too large' });
        return reply(res, 400, { error: 'unreadable request body' });
      }
    }
    // Closing the browser side (tab closed, EventSource.close()) drops the
    // upstream request too, so an SSE stream never outlives its reader.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await fetchImpl(`${url}${route}${search}`, {
        method: req.method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body,
        // A redirect would replay the Authorization header elsewhere: relay it as is instead.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return unavailable(res, `agents server unreachable at ${url}`);
    }

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    });
    if (!upstream.body) return res.end();
    // An aborted or broken upstream stream surfaces as an 'error' event: end
    // the response quietly (an unhandled one would crash the board).
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  };
}
