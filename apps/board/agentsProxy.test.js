import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentsProxy, defaultTokenFile, DEFAULT_AGENTS_URL } from './agentsProxy.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// A stand-in for apps/agents that records what reached it.
async function upstream(t, handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method, url: req.url, authorization: req.headers.authorization,
      contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString(),
    });
    handler(req, res);
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${port}`, seen };
}

// The board side: a server that does nothing but hand /api/factory/* to the
// proxy. The path is NOT normalised here (unlike the real board, which goes
// through `new URL`), so the proxy's own route check is what gets exercised.
async function board(t, options) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-proxy-'));
  const tokenFile = path.join(dir, 'agents.token');
  await writeFile(tokenFile, 'tok-123\n');
  const proxy = createAgentsProxy({ tokenFile, ...options });
  const server = createServer((req, res) => {
    const at = req.url.indexOf('?');
    if (at === -1) proxy(req, res, req.url);
    else proxy(req, res, req.url.slice(0, at), req.url.slice(at));
  });
  const port = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, port, tokenFile, dir };
}

// fetch() normalises the URL; this sends the request line exactly as given.
function raw(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET is forwarded with the token added server-side', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"repos":["api"]}'); });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { repos: ['api'] });
  assert.deepEqual(agents.seen.map(({ method, url, authorization }) => ({ method, url, authorization })), [
    { method: 'GET', url: '/health', authorization: 'Bearer tok-123' },
  ]);
});

test('the token never reaches the browser, nor does an Authorization sent by it', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b' }); res.end('{}'); });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/skills`, { headers: { authorization: 'Bearer browser-chosen' } });
  assert.equal(res.status, 200);
  assert.equal(agents.seen[0].authorization, 'Bearer tok-123');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.doesNotMatch(JSON.stringify([...res.headers]), /tok-123/);
});

test('POST carries its body as JSON, and the agents server refusal is passed straight through', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"a run is already active on api"}'); });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/runs?x=1`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"repo":"api","prompt":"go"}' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'a run is already active on api' });
  assert.equal(agents.seen[0].url, '/runs?x=1');
  assert.equal(agents.seen[0].body, '{"repo":"api","prompt":"go"}');
  // The proxy decides the content type of what it forwards, not the browser.
  assert.equal(agents.seen[0].contentType, 'application/json');
});

test('a GET carries no body and no content type', async (t) => {
  const agents = await upstream(t, (req, res) => res.end('{}'));
  const { base } = await board(t, { url: agents.url });
  await fetch(`${base}/api/factory/runs`, { headers: { 'content-type': 'application/json' } });
  assert.equal(agents.seen[0].contentType, undefined);
  assert.equal(agents.seen[0].body, '');
});

test('DELETE reaches /runs/:id', async (t) => {
  const agents = await upstream(t, (req, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}'); });
  const { base } = await board(t, { url: agents.url });
  assert.equal((await fetch(`${base}/api/factory/runs/run-1`, { method: 'DELETE' })).status, 202);
  assert.equal(agents.seen[0].method, 'DELETE');
  assert.equal(agents.seen[0].url, '/runs/run-1');
});

test('the SSE stream is relayed as it arrives', async (t) => {
  const agents = await upstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: stdout\ndata: {"text":"one"}\n\n');
    setTimeout(() => res.end('event: status\ndata: {"status":"succeeded"}\n\n'), 30);
  });
  const { base } = await board(t, { url: agents.url });
  const res = await fetch(`${base}/api/factory/runs/run-1/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  // The first event is readable before the upstream has finished.
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"text":"one"/);
  let rest = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  assert.match(rest, /"status":"succeeded"/);
});

test('only the agents routes are relayed, with their usual methods', async (t) => {
  const agents = await upstream(t, (req, res) => res.end('{}'));
  const { base, port } = await board(t, { url: agents.url });
  // Sent verbatim (no URL normalisation), so each one really reaches the proxy.
  for (const route of [
    '/api/factory/../etc', '/api/factory/health/../runs', '/api/factory/other', '/api/factory/', '/api/factory',
    '/api/factory/runs/a/b/c', '/api/factory/runs/%2e%2e', '/api/factory/runs/a%2fb', '/api/factory/runs/../x',
    '/api/factory/runs/a/events/x', '/api/factory/healthz', '/api/factoryX/health', '/api/factory//health',
  ]) {
    const res = await raw(port, 'GET', route);
    assert.equal(res.status, 404, route);
    assert.deepEqual(JSON.parse(res.body), { error: 'unknown factory route' }, route);
  }
  for (const method of ['PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
    assert.equal((await fetch(`${base}/api/factory/health`, { method })).status, 405, method);
  }
  assert.equal(agents.seen.length, 0);
});

test('a missing token file or an unreachable agents server is a 503 with a reason', async (t) => {
  const missing = await board(t, { url: 'http://127.0.0.1:9' });
  await rm(missing.tokenFile);
  const noToken = await fetch(`${missing.base}/api/factory/health`);
  assert.equal(noToken.status, 503);
  assert.match((await noToken.json()).detail, /no token at/);

  const down = await board(t, { url: 'http://127.0.0.1:9' });
  const unreachable = await fetch(`${down.base}/api/factory/health`);
  assert.equal(unreachable.status, 503);
  const body = await unreachable.json();
  assert.match(body.detail, /unreachable/);
  assert.doesNotMatch(JSON.stringify(body), /tok-123/);
});

test('a response without a body or a content type is relayed as an empty one', async (t) => {
  const fetchImpl = async () => ({ status: 204, headers: new Headers(), body: null });
  const { base } = await board(t, { fetchImpl });
  const res = await fetch(`${base}/api/factory/runs/run-1`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
});

test('an upstream stream that breaks mid-way ends the response without crashing the board', async (t) => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
      setTimeout(() => controller.error(new Error('boom')), 10);
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const { base } = await board(t, { fetchImpl });
  const res = await fetch(`${base}/api/factory/runs/run-1/events`);
  assert.equal(await res.text(), 'partial');
});

test('the upstream request is aborted when the browser goes away', async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  const agents = await upstream(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
    res.on('close', closed);
  });
  const { base } = await board(t, { url: agents.url });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const controller = new AbortController();
  const res = await fetch(`${base}/api/factory/runs/run-1/events`, { signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await upstreamClosed;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test('a request body that cannot be read is a 400 and nothing is forwarded', async () => {
  let called = false;
  const proxy = createAgentsProxy({ tokenFile: import.meta.filename, fetchImpl: async () => { called = true; } });
  const req = new Readable({ read() { this.destroy(new Error('aborted')); } });
  req.method = 'POST';
  const out = {};
  const res = {
    on() {}, writeHead(status) { out.status = status; }, end(body) { out.body = body; },
  };
  await proxy(req, res, '/api/factory/runs');
  assert.equal(out.status, 400);
  assert.deepEqual(JSON.parse(out.body), { error: 'unreadable request body' });
  assert.equal(called, false);
});

test('the defaults point at the local agents server and its token file', async () => {
  assert.equal(DEFAULT_AGENTS_URL, 'http://127.0.0.1:4318');
  assert.equal(defaultTokenFile('/home/u'), path.join('/home/u', '.maggie', 'agents.token'));
  assert.equal(defaultTokenFile(), path.join(process.env.HOME ?? process.env.USERPROFILE, '.maggie', 'agents.token'));
  // No options at all, and no search argument: still a working (route-checking) proxy.
  const proxy = createAgentsProxy();
  const out = {};
  await proxy({ method: 'GET' }, { writeHead(status) { out.status = status; }, end() {} }, '/api/factory/nope');
  assert.equal(out.status, 404);
});
