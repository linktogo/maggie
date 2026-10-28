import { ref, onUnmounted } from 'vue';

const NOTIFY_STATES = ['question', 'done'];

function diffTransitions(prev, next) {
  const out = [];
  for (const [name, repoEntry] of Object.entries(next)) {
    const prevSessions = prev[name]?.sessions ?? {};
    for (const [sessionId, session] of Object.entries(repoEntry.sessions ?? {})) {
      if (NOTIFY_STATES.includes(session.status) && prevSessions[sessionId]?.status !== session.status) {
        out.push({ name, sessionId, title: session.title, status: session.status });
      }
    }
  }
  return out;
}

export function useBoard({ intervalMs = 3000, fetchImpl = fetch } = {}) {
  const repos = ref({});
  const error = ref(null);
  const transitions = ref([]);
  const connected = ref(true);
  const loaded = ref(false); // true once the first fetch has succeeded
  let prev = null; // null until the first successful fetch establishes a baseline

  async function refresh() {
    try {
      const res = await fetchImpl('/api/board');
      const data = await res.json();
      const next = data.repos ?? {};
      transitions.value = prev ? diffTransitions(prev, next) : [];
      prev = next;
      repos.value = next;
      error.value = null;
      connected.value = true;
      loaded.value = true;
    } catch (err) {
      error.value = err;
      connected.value = false;
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  function stop() { clearInterval(timer); }
  onUnmounted(stop);

  return { repos, error, transitions, connected, loaded, refresh, stop };
}
