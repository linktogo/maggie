import { ref, onUnmounted } from 'vue';

// Generation takes minutes, so the browser starts a job and then polls: the
// server owns the run, this only reports what became of it.
export function useRetroDoc({ fetchImpl = fetch, intervalMs = 3000 } = {}) {
  const jobs = ref([]);
  const error = ref(null);
  const available = ref(true);
  let timer = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function refresh() {
    try {
      const res = await fetchImpl('/api/retro-doc');
      if (res.status === 503) {
        available.value = false;
        stop();
        return;
      }
      available.value = true;
      const data = await res.json();
      jobs.value = data.jobs ?? [];
      // Polling exists for running jobs only; nothing running, nothing to poll.
      if (!jobs.value.some((job) => job.status === 'running')) stop();
    } catch (err) {
      error.value = err.message ?? String(err);
    }
  }

  async function start(repo, provider) {
    error.value = null;
    const res = await fetchImpl('/api/retro-doc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, provider }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data.error ?? `HTTP ${res.status}`;
      return null;
    }
    await refresh();
    if (!timer) timer = setInterval(refresh, intervalMs);
    return data.job ?? null;
  }

  function latestFor(repo) {
    return jobs.value.find((job) => job.repo === repo) ?? null;
  }

  refresh();
  onUnmounted(stop);

  return { jobs, error, available, start, refresh, stop, latestFor };
}
