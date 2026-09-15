<script setup>
import { ref, computed } from 'vue';
import { formatTokens } from './formatTokens.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  entries: { type: Array, required: true },
});

const repoFilter = ref('');
const sortKey = ref('endedAt');
const sortDir = ref('desc');

function totalOf(entry) {
  const u = entry.usage ?? { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}

function durationLabel(entry) {
  if (!entry.startedAt || !entry.endedAt) return '';
  const ms = new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime();
  return t('table.durationMinutes', { minutes: Math.max(0, Math.round(ms / 60000)) });
}

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

function valueFor(entry, key) {
  if (key === 'total') return totalOf(entry);
  return entry[key] ?? '';
}

const rows = computed(() => {
  const filtered = props.entries.filter(
    (e) => !repoFilter.value || e.repo.toLowerCase().includes(repoFilter.value.toLowerCase()),
  );
  return [...filtered].sort((a, b) => {
    const av = valueFor(a, sortKey.value);
    const bv = valueFor(b, sortKey.value);
    if (av < bv) return sortDir.value === 'asc' ? -1 : 1;
    if (av > bv) return sortDir.value === 'asc' ? 1 : -1;
    return 0;
  });
});
</script>

<template>
  <div class="bg-surface border border-line rounded-card shadow-panel p-4">
    <input
      data-test="history-repo-filter"
      v-model="repoFilter"
      :placeholder="t('filter.searchRepo')"
      class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface mb-3 focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    />
    <table class="w-full text-sm text-left">
      <thead>
        <tr class="text-ink-muted bg-surface-muted uppercase tracking-wide text-xs border-b border-line">
          <th class="py-2 px-3 cursor-pointer" data-test="sort-repo" @click="sortBy('repo')">{{ t('table.repo') }}</th>
          <th class="py-2 px-3 cursor-pointer" data-test="sort-title" @click="sortBy('title')">{{ t('table.title') }}</th>
          <th class="py-2 px-3">{{ t('table.started') }}</th>
          <th class="py-2 px-3">{{ t('table.ended') }}</th>
          <th class="py-2 px-3">{{ t('table.duration') }}</th>
          <th class="py-2 px-3 text-right">{{ t('chart.input') }}</th>
          <th class="py-2 px-3 text-right">{{ t('chart.output') }}</th>
          <th class="py-2 px-3 text-right">{{ t('chart.cacheWrite') }}</th>
          <th class="py-2 px-3 text-right">{{ t('chart.cacheRead') }}</th>
          <th class="py-2 px-3 text-right cursor-pointer" data-test="sort-total" @click="sortBy('total')">{{ t('table.total') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in rows" :key="`${e.repo}-${e.sessionId}`" data-test="history-row" class="border-b border-line-soft odd:bg-surface-muted hover:bg-surface-hover">
          <td class="py-1.5 px-3">{{ e.repo }}</td>
          <td class="py-1.5 px-3">{{ e.title ?? t('session.untitled') }}</td>
          <td class="py-1.5 px-3">{{ e.startedAt }}</td>
          <td class="py-1.5 px-3">{{ e.endedAt }}</td>
          <td class="py-1.5 px-3">{{ durationLabel(e) }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.inputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.outputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.cacheCreationInputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">{{ e.usage?.cacheReadInputTokens ?? 0 }}</td>
          <td class="py-1.5 px-3 text-right">
            <span class="inline-block bg-surface-muted rounded-badge px-1.5 py-0.5 font-semibold">{{ formatTokens(totalOf(e)) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="text-xs text-ink-faint mt-2">{{ t('history.empty') }}</p>
  </div>
</template>
