import { ref, onUnmounted } from 'vue';

const FINAL = ['succeeded', 'failed', 'cancelled', 'timed-out'];
const OUTPUT_TYPES = ['stdout', 'stderr'];

// The browser talks to the board, which relays to the agents server and holds
// the token: nothing in here ever sees a credential.
export function useFactory({ fetchImpl = fetch, EventSourceImpl = globalThis.EventSource } = {}) {
  const health = ref(null);
  const skills = ref([]);
  const runs = ref([]);
  const output = ref([]);
  const followed = ref(null);
  const error = ref(null);
  const detail = ref(null);
  const available = ref(true);
  let source = null;

  async function api(path, init) {
    const res = await fetchImpl(`/api/factory${path}`, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok === true, status: res.status, data };
  }

  async function refreshRuns() {
    const { ok, data } = await api('/runs');
    if (ok) runs.value = data.runs ?? [];
  }

  async function load() {
    try {
      const [healthResult, skillsResult] = await Promise.all([api('/health'), api('/skills')]);
      if (!healthResult.ok) {
        available.value = false;
        detail.value = healthResult.data.detail ?? healthResult.data.error ?? `HTTP ${healthResult.status}`;
        return;
      }
      available.value = true;
      detail.value = null;
      health.value = healthResult.data;
      skills.value = skillsResult.data.skills ?? [];
      await refreshRuns();
    } catch (err) {
      available.value = false;
      detail.value = err.message ?? String(err);
    }
  }

  function close() {
    if (source) source.close();
    source = null;
  }

  // The stream is closed on the final status: left open, EventSource would
  // reconnect when the server ends the response and replay the whole output.
  function follow(id) {
    close();
    followed.value = id;
    output.value = [];
    const stream = new EventSourceImpl(`/api/factory/runs/${id}/events`);
    source = stream;
    for (const type of OUTPUT_TYPES) {
      stream.addEventListener(type, (event) => output.value.push({ type, text: JSON.parse(event.data).text }));
    }
    stream.addEventListener('status', (event) => {
      const { status } = JSON.parse(event.data);
      output.value.push({ type: 'status', text: status });
      if (FINAL.includes(status)) {
        close();
        void refreshRuns();
      }
    });
    stream.onerror = close;
  }

  async function start({ repo, provider, model, prompt, skill }) {
    error.value = null;
    const body = { repo, provider };
    if (model) body.model = model;
    if (prompt) body.prompt = prompt;
    if (skill) body.skill = skill;
    try {
      const { ok, status, data } = await api('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!ok) {
        error.value = data.error ?? `HTTP ${status}`;
        return null;
      }
      await refreshRuns();
      follow(data.id);
      return data.run;
    } catch (err) {
      error.value = err.message ?? String(err);
      return null;
    }
  }

  async function cancel(id) {
    error.value = null;
    try {
      const { ok, status, data } = await api(`/runs/${id}`, { method: 'DELETE' });
      if (!ok) error.value = data.error ?? `HTTP ${status}`;
      await refreshRuns();
    } catch (err) {
      error.value = err.message ?? String(err);
    }
  }

  void load();
  onUnmounted(close);

  return { health, skills, runs, output, followed, error, detail, available, load, refreshRuns, start, cancel, follow, close };
}
