import { ref, getCurrentInstance, onUnmounted } from 'vue';

/** Characters per input POST: at most 64 KiB once UTF-8 encoded, the server's limit. */
export const INPUT_CHUNK_CHARS = 16384;

const JSON_HEADERS = { 'content-type': 'application/json' };

const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// A chunk never ends on the first half of a surrogate pair (an emoji cut in two).
function nextChunk(text) {
  let end = Math.min(text.length, INPUT_CHUNK_CHARS);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// One shell of the agents server, through the board's relay. It dies with its
// reader: close() runs on unmount and on pagehide, and a dropped stream is not
// reconnected (the server kills the orphan a few seconds later).
export function useTerminal({
  fetchImpl = fetch,
  EventSourceImpl = globalThis.EventSource,
  win = globalThis.window,
  flushMs = 10,
  resizeMs = 100,
} = {}) {
  const status = ref('idle');
  const exitCode = ref(null);
  const error = ref(null);
  const cwd = ref(null);
  let id = null;
  let source = null;
  let queue = '';
  let sending = false;
  let flushTimer = null;
  let resizeTimer = null;
  let generation = 0; // bumped by every open() and close(): a stale open() gives up

  const post = (path, body) => fetchImpl(`/api/factory/terminals/${id}${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  function stopStream() {
    if (source) source.close();
    source = null;
  }

  async function open(repo, { cols, rows }, onData) {
    if (status.value === 'opening' || status.value === 'open') return;
    const ticket = ++generation;
    status.value = 'opening';
    exitCode.value = null;
    error.value = null;
    let res;
    let data;
    try {
      res = await fetchImpl('/api/factory/terminals', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ repo, cols, rows }) });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      if (ticket !== generation) return;
      status.value = 'error';
      error.value = err.message;
      return;
    }
    // Closed while the POST was in flight: the shell it created has no reader.
    if (ticket !== generation) {
      if (res.ok) await kill(data.terminal.id);
      return;
    }
    if (!res.ok) {
      status.value = 'error';
      error.value = data.detail ?? data.error ?? `HTTP ${res.status}`;
      return;
    }
    ({ id } = data.terminal);
    cwd.value = data.terminal.cwd;
    status.value = 'open';
    const stream = new EventSourceImpl(`/api/factory/terminals/${id}/events`);
    source = stream;
    stream.addEventListener('data', (event) => onData(decode(event.data)));
    stream.addEventListener('exit', (event) => {
      exitCode.value = JSON.parse(event.data).code;
      status.value = 'exited';
      stopStream();
    });
    stream.onerror = () => {
      status.value = 'disconnected';
      stopStream();
    };
  }

  async function flush() {
    flushTimer = null;
    sending = true;
    while (queue && status.value === 'open') {
      const chunk = nextChunk(queue);
      queue = queue.slice(chunk.length);
      try {
        await post('/input', { data: chunk });
      } catch (err) {
        error.value = err.message;
      }
    }
    sending = false;
  }

  function write(data) {
    if (status.value !== 'open') return;
    queue += data;
    if (!flushTimer && !sending) flushTimer = setTimeout(flush, flushMs);
  }

  function resize(cols, rows) {
    if (status.value !== 'open') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { void post('/resize', { cols, rows }).catch(() => {}); }, resizeMs);
  }

  // keepalive: the DELETE must outlive the page when it runs on pagehide.
  async function kill(target) {
    try {
      await fetchImpl(`/api/factory/terminals/${target}`, { method: 'DELETE', keepalive: true });
    } catch { /* the server kills an unread shell anyway */ }
  }

  // Also cancels an open() still in flight: its shell is killed once it exists.
  async function close() {
    generation += 1;
    const target = id;
    id = null;
    stopStream();
    clearTimeout(flushTimer);
    clearTimeout(resizeTimer);
    flushTimer = null;
    queue = '';
    status.value = 'idle';
    if (target) await kill(target);
  }

  const onPageHide = () => { void close(); };
  win?.addEventListener('pagehide', onPageHide);
  if (getCurrentInstance()) {
    onUnmounted(() => {
      win?.removeEventListener('pagehide', onPageHide);
      void close();
    });
  }

  return { status, exitCode, error, cwd, open, write, resize, close };
}
