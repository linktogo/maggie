import { onScopeDispose, ref, watch } from 'vue';

// Loads /api/history only while `enabled` — the day total needs the closed
// sessions, and with no day threshold nothing should be fetched. The file only
// grows when a session closes, so besides a slow safety-net poll it refetches
// whenever `refreshOn` changes (the caller passes the live session count).
export function useDayHistory({ fetchImpl = fetch, intervalMs = 60_000, enabled, refreshOn = null }) {
  const entries = ref([]);
  const loaded = ref(false);
  let timer = null;
  let generation = 0; // bumped on stop, so a fetch started before it is ignored

  async function load() {
    const mine = generation;
    try {
      const res = await fetchImpl('/api/history');
      const data = await res.json();
      if (mine !== generation || !Array.isArray(data)) return;
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
    generation += 1;
    clearInterval(timer);
    timer = null;
    loaded.value = false;
  }

  watch(enabled, (on) => (on ? start() : stop()), { immediate: true });
  if (refreshOn) watch(refreshOn, () => { if (timer !== null) load(); });
  onScopeDispose(stop, true);

  return { entries, loaded };
}
