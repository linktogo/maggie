<script setup>
import { ref, computed } from 'vue';
import { formatTokens } from './formatTokens.js';
import { useI18n } from './i18n.js';

const { t, locale } = useI18n();

const props = defineProps({
  entries: { type: Array, required: true },
});

// Columns whose header sorts the table; `test` keeps the data-test hooks short.
const SORTABLE = [
  { key: 'repo', label: 'table.repo', test: 'repo' },
  { key: 'title', label: 'table.title', test: 'title' },
  { key: 'startedAt', label: 'table.started', test: 'started' },
  { key: 'endedAt', label: 'table.ended', test: 'ended' },
];

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

// The store keeps ISO timestamps; a person reads a short local date-time.
// An unparseable value is shown as is rather than as "Invalid Date".
function dateLabel(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' });
}

function count(n) {
  return (n ?? 0).toLocaleString(locale.value);
}

function ariaSort(key) {
  if (sortKey.value !== key) return 'none';
  return sortDir.value === 'asc' ? 'ascending' : 'descending';
}

function sortArrow(key) {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'asc' ? '▲' : '▼';
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
      class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface mb-3 w-full sm:w-64 focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    />
    <div class="overflow-x-auto -mx-4 px-4">
      <table class="w-full text-sm text-left tabular-nums">
        <thead>
          <tr class="text-ink-muted bg-surface-muted uppercase tracking-wide text-xs border-b border-line whitespace-nowrap">
            <th v-for="col in SORTABLE" :key="col.key" class="py-2 px-3" :aria-sort="ariaSort(col.key)">
              <button type="button" :data-test="`sort-${col.test}`" class="uppercase tracking-wide hover:text-ink-soft" @click="sortBy(col.key)">
                {{ t(col.label) }} <span class="text-accent">{{ sortArrow(col.key) }}</span>
              </button>
            </th>
            <th class="py-2 px-3">{{ t('table.duration') }}</th>
            <th class="py-2 px-3 text-right">{{ t('chart.input') }}</th>
            <th class="py-2 px-3 text-right">{{ t('chart.output') }}</th>
            <th class="py-2 px-3 text-right">{{ t('chart.cacheWrite') }}</th>
            <th class="py-2 px-3 text-right">{{ t('chart.cacheRead') }}</th>
            <th class="py-2 px-3 text-right" :aria-sort="ariaSort('total')">
              <button type="button" data-test="sort-total" class="uppercase tracking-wide hover:text-ink-soft" @click="sortBy('total')">
                <span class="text-accent">{{ sortArrow('total') }}</span> {{ t('table.total') }}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in rows" :key="`${e.repo}-${e.sessionId}`" data-test="history-row" class="border-b border-line-soft hover:bg-surface-hover transition-colors">
            <td class="py-1.5 px-3 font-medium text-ink whitespace-nowrap">{{ e.repo }}</td>
            <td class="py-1.5 px-3 max-w-xs truncate" :title="e.title ?? ''">{{ e.title ?? t('session.untitled') }}</td>
            <td class="py-1.5 px-3 whitespace-nowrap" :title="e.startedAt">{{ dateLabel(e.startedAt) }}</td>
            <td class="py-1.5 px-3 whitespace-nowrap" :title="e.endedAt">{{ dateLabel(e.endedAt) }}</td>
            <td class="py-1.5 px-3 whitespace-nowrap">{{ durationLabel(e) }}</td>
            <td class="py-1.5 px-3 text-right">{{ count(e.usage?.inputTokens) }}</td>
            <td class="py-1.5 px-3 text-right">{{ count(e.usage?.outputTokens) }}</td>
            <td class="py-1.5 px-3 text-right">{{ count(e.usage?.cacheCreationInputTokens) }}</td>
            <td class="py-1.5 px-3 text-right">{{ count(e.usage?.cacheReadInputTokens) }}</td>
            <td class="py-1.5 px-3 text-right">
              <span class="inline-block bg-accent-soft text-on-accent-soft rounded-badge px-1.5 py-0.5 font-semibold">{{ formatTokens(totalOf(e)) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="rows.length === 0" class="text-xs text-ink-faint mt-2">{{ t('history.empty') }}</p>
  </div>
</template>
