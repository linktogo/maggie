import { ref, computed, onUnmounted } from 'vue';

const MAX_RELOADS = 3;
const RELOAD_DELAY_MS = 1000;
const JSON_HEADERS = { 'content-type': 'application/json' };

// The browser talks to the board, which relays to the agents server and holds
// the token: nothing in here ever sees a credential.
export function useThreads({
  fetchImpl = fetch,
  EventSourceImpl = globalThis.EventSource,
  pollMs = 5000,
  doc = globalThis.document,
} = {}) {
  const health = ref(null);
  const skills = ref([]);
  const projects = ref([]);
  const threads = ref([]);
  const thread = ref(null);
  const messages = ref([]);
  const error = ref(null);
  const available = ref(true);
  const busy = ref(false);
  let source = null;
  let lastQuery = {};
  let opening = 0;
  let reloadTimer = null;
  let retries = 0;

  const resumable = computed(() => thread.value?.provider === 'claude-cli'
    && !!thread.value.sessionId
    && thread.value.status === 'idle');

  async function api(path, init) {
    const res = await fetchImpl(`/api/factory${path}`, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok === true, status: res.status, data };
  }

  function fail({ status, data }) {
    const reason = data.error ?? `HTTP ${status}`;
    // e.g. "git-failed: git fetch failed: …": the code alone does not say what went wrong.
    error.value = data.detail ? `${reason}: ${data.detail}` : reason;
  }

  async function refreshProjects() {
    // Never throws: a failed refresh keeps the previous list.
    try {
      const { ok, data } = await api('/projects');
      if (ok) projects.value = data.projects ?? [];
    } catch { /* the list is just not refreshed */ }
  }

  async function loadThreads({ repo, q = '', archived = false } = {}) {
    lastQuery = { repo, q, archived };
    const params = new URLSearchParams();
    if (repo) params.set('repo', repo);
    if (archived) params.set('status', 'archived');
    if (q) params.set('q', q);
    const qs = params.toString();
    try {
      const { ok, data } = await api(`/threads${qs ? `?${qs}` : ''}`);
      if (ok) threads.value = data.threads ?? [];
    } catch { /* the list is just not refreshed */ }
  }

  async function load() {
    try {
      const [healthResult, skillsResult] = await Promise.all([api('/health'), api('/skills')]);
      if (!healthResult.ok) {
        available.value = false;
        error.value = healthResult.data.detail ?? healthResult.data.error ?? `HTTP ${healthResult.status}`;
        return;
      }
      available.value = true;
      error.value = null;
      health.value = healthResult.data;
      skills.value = skillsResult.data.skills ?? [];
      await refreshProjects();
    } catch (err) {
      available.value = false;
      error.value = err.message ?? String(err);
    }
  }

  function close() {
    if (source) source.close();
    source = null;
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  async function refreshAfterRun(id) {
    try {
      const { ok, data } = await api(`/threads/${id}`);
      // The stored history is authoritative once the run is over.
      if (ok && thread.value?.id === id) {
        thread.value = data.thread;
        messages.value = data.messages ?? [];
      }
    } catch { /* the thread keeps its last known state */ }
    await Promise.all([refreshProjects(), loadThreads(lastQuery)]);
  }

  // The stream is closed on a non-running status: left open, EventSource would
  // reconnect when the server ends the response and replay the whole output.
  // `after` asks the server to replay what was stored past the last message held
  // (the reply just posted, or a run that already failed), then to go live.
  function follow(id) {
    close();
    const after = messages.value.at(-1)?.id ?? 0;
    const stream = new EventSourceImpl(`/api/factory/threads/${id}/events?after=${after}`);
    source = stream;
    stream.addEventListener('message', (event) => {
      retries = 0;
      const message = JSON.parse(event.data);
      if (!messages.value.some((m) => m.id === message.id)) messages.value.push(message);
    });
    stream.addEventListener('status', (event) => {
      const { status } = JSON.parse(event.data);
      retries = 0;
      if (status === 'running') return;
      if (source === stream) close();
      void refreshAfterRun(id);
    });
    // A dropped stream reloads the thread (instead of letting EventSource reconnect), after a delay and at most MAX_RELOADS times in a row.
    stream.onerror = () => {
      if (source !== stream) return;
      close();
      if (retries >= MAX_RELOADS) {
        error.value = 'lost the connection to the agents server';
        return;
      }
      retries += 1;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void loadThread(id, true);
      }, RELOAD_DELAY_MS);
    };
  }

  const open = (id) => loadThread(id, false);

  async function loadThread(id, reload) {
    const ticket = ++opening;
    if (!reload) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
      retries = 0;
    }
    error.value = null;
    try {
      const result = await api(`/threads/${id}`);
      if (ticket !== opening) return;
      if (!result.ok) {
        fail(result);
        return;
      }
      close();
      thread.value = result.data.thread;
      messages.value = result.data.messages ?? [];
      if (thread.value.status === 'running') follow(id);
    } catch (err) {
      if (ticket === opening) error.value = err.message ?? String(err);
    }
  }

  // `onRefused(result)` claims a failure it reports itself: `fail` is then skipped.
  async function mutate(path, init, onOk, onRefused) {
    error.value = null;
    busy.value = true;
    try {
      const result = await api(path, init);
      if (!result.ok) {
        if (!onRefused?.(result)) fail(result);
        return false;
      }
      await onOk(result.data);
      return true;
    } catch (err) {
      error.value = err.message ?? String(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function create({ repo, provider, model, prompt, skill, worktree }) {
    const body = { repo };
    if (worktree) body.worktree = true;
    if (provider) body.provider = provider;
    if (model) body.model = model;
    if (prompt) body.prompt = prompt;
    if (skill) body.skill = skill;
    let created = null;
    const ticket = opening;
    await mutate('/threads', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, async (data) => {
      created = data.thread;
      // Another thread opened while the POST was in flight stays current.
      if (opening === ticket) await open(created.id);
      await Promise.all([refreshProjects(), loadThreads(lastQuery)]);
    });
    return created;
  }

  function reply(prompt) {
    if (!thread.value) return Promise.resolve(false);
    const id = thread.value.id;
    return mutate(`/threads/${id}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ prompt }) }, (data) => {
      void refreshProjects();
      if (thread.value?.id !== id) return;
      opening += 1; // a stale open() response must not replace this run's stream
      thread.value = data.thread;
      follow(id);
    });
  }

  async function stop() {
    if (!thread.value) return;
    await mutate(`/threads/${thread.value.id}/run`, { method: 'DELETE' }, (data) => {
      // SIGTERM is asynchronous: the stream stays open so the final status settles the lists.
      if (data.thread) thread.value = data.thread;
    });
  }

  function setStatus(id, status) {
    return mutate(`/threads/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ status }) }, async (data) => {
      if (thread.value?.id === id) thread.value = data.thread;
      await Promise.all([refreshProjects(), loadThreads(lastQuery)]);
    });
  }

  const archive = (id) => setStatus(id, 'archived');
  const restore = (id) => setStatus(id, 'idle');

  // A dirty worktree is not an error: the caller asks the user, then retries with force.
  async function destroy(path, onOk) {
    let dirty = false;
    let data = {};
    const ok = await mutate(path, { method: 'DELETE' }, async (body) => {
      data = body;
      await onOk();
    }, ({ status, data: body }) => {
      dirty = status === 409 && body.error === 'worktree-dirty';
      return dirty;
    });
    return ok ? { ok: true, branchKept: data.branchKept } : { ok: false, dirty };
  }

  const forceQuery = (force) => (force ? '?force=1' : '');

  function remove(id, { force = false } = {}) {
    return destroy(`/threads/${id}${forceQuery(force)}`, async () => {
      opening += 1;
      if (thread.value?.id === id) {
        close();
        thread.value = null;
        messages.value = [];
      }
      await Promise.all([refreshProjects(), loadThreads(lastQuery)]);
    });
  }

  function removeWorktree(id, { force = false } = {}) {
    return destroy(`/threads/${id}/worktree${forceQuery(force)}`, async () => {
      if (thread.value?.id === id) await open(id);
      await loadThreads(lastQuery);
    });
  }

  const timer = setInterval(() => {
    if (doc?.visibilityState === 'visible') void refreshProjects();
  }, pollMs);

  onUnmounted(() => {
    clearInterval(timer);
    close();
  });

  return {
    health, skills, projects, threads, thread, messages, error, available, busy, resumable,
    load, loadThreads, open, create, reply, stop, archive, restore, remove, removeWorktree,
  };
}
