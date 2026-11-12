import { ref } from 'vue';

export function useHistory({ fetchImpl = fetch } = {}) {
  const entries = ref([]);
  async function load() {
    try {
      const res = await fetchImpl('/api/history');
      entries.value = await res.json();
    } catch {
      entries.value = [];
    }
  }
  load();
  return { entries, load };
}
