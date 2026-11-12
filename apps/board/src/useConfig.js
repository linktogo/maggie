import { ref } from 'vue';

export function useConfig({ fetchImpl = fetch } = {}) {
  const repos = ref({});
  async function load() {
    try {
      const res = await fetchImpl('/api/config');
      const data = await res.json();
      repos.value = data.repos ?? {};
    } catch {
      repos.value = {};
    }
  }
  load();
  return { repos, load };
}
