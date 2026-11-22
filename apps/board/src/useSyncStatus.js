import { ref, onUnmounted } from 'vue';

// The last `maggie sync --check --out <board dir>/sync-status.json`: per repository,
// whether its default branch matches what the skills library renders.
export function useSyncStatus({ intervalMs = 60000, fetchImpl = fetch } = {}) {
  const repos = ref({});
  const generatedAt = ref(null);

  async function refresh() {
    try {
      const res = await fetchImpl('/api/sync-status');
      const data = await res.json();
      repos.value = data.repos ?? {};
      generatedAt.value = data.generatedAt ?? null;
    } catch {
      // keep the last known status: a check is minutes old anyway
    }
  }

  refresh();
  const timer = setInterval(refresh, intervalMs);
  function stop() { clearInterval(timer); }
  onUnmounted(stop);

  return { repos, generatedAt, refresh, stop };
}
