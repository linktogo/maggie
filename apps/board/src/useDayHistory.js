import { onScopeDispose, ref, watch } from 'vue';

// Polls /api/history only while `enabled` — the day total needs the closed
// sessions, and with no day threshold nothing should be fetched.
export function useDayHistory({ fetchImpl = fetch, intervalMs = 3000, enabled }) {
  const entries = ref([]);
  const loaded = ref(false);
  let timer = null;

  async function load() {
    try {
      const res = await fetchImpl('/api/history');
      const data = await res.json();
      if (!Array.isArray(data)) return;
      entries.value = data;
      loaded.value = true;
    } catch { /* keep what we had; the live figures still work */ }
  }
  function start() {
    if (timer !== null) return;
    load();
    timer = setInterval(load, intervalMs);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    loaded.value = false;
  }

  watch(enabled, (on) => (on ? start() : stop()), { immediate: true });
  onScopeDispose(stop, true);

  return { entries, loaded };
}
