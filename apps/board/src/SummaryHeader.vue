<script setup>
import { computed } from 'vue';
import { STATUS_STYLES } from './statusStyles.js';
import { useI18n } from './i18n.js';
import { budget } from './budget.js';
import { formatChartValue } from './chartFormat.js';

const { t } = useI18n();

const props = defineProps({
  repos: { type: Object, required: true },
  dayCost: { type: Number, default: null },
  dayPartial: { type: Boolean, default: false },
});

// A repo with zero active sessions counts as one "todo" card (same
// placeholder behavior the board itself shows); otherwise every session
// counts individually, so a repo with two concurrent sessions counts twice.
const counts = computed(() => {
  const c = { todo: 0, inprogress: 0, question: 0, done: 0 };
  for (const repoEntry of Object.values(props.repos)) {
    const sessions = Object.values(repoEntry.sessions ?? {});
    if (sessions.length === 0) { c.todo += 1; continue; }
    for (const s of sessions) if (c[s.status] !== undefined) c[s.status] += 1;
  }
  return c;
});
const total = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0));
const tiles = computed(() => ['todo', 'inprogress', 'question', 'done'].map((status) => ({
  status, count: counts.value[status], label: t(`status.${status}`), dot: STATUS_STYLES[status].dot,
})));
const percentDone = computed(() => (total.value ? Math.round((counts.value.done / total.value) * 100) : 0));
</script>

<template>
  <div class="mb-5 grid grid-cols-2 gap-gutter sm:grid-cols-3 lg:grid-cols-6">
    <div class="rounded-card border border-line-soft bg-surface px-4 py-3 shadow-panel">
      <div class="eyebrow">{{ t('summary.repos') }}</div>
      <div class="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink-strong">{{ total }}<span class="sr-only">{{ ' ' }}{{ t('summary.repos') }}</span></div>
    </div>
    <div
      v-for="tile in tiles" :key="tile.status"
      :data-test="`summary-${tile.status}`"
      class="rounded-card border border-line-soft bg-surface px-4 py-3 shadow-panel"
    >
      <div class="flex items-center gap-1.5">
        <span :class="['size-2 rounded-full', tile.dot, tile.status === 'inprogress' && tile.count > 0 ? 'status-dot-live' : '']" aria-hidden="true"></span>
        <span class="sr-only">{{ tile.count }}{{ ' ' }}</span><span class="eyebrow">{{ tile.label }}</span>
      </div>
      <div class="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink-strong" aria-hidden="true">{{ tile.count }}</div>
    </div>
    <div class="col-span-2 rounded-card border border-line-soft bg-surface px-4 py-3 shadow-panel sm:col-span-3 lg:col-span-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="eyebrow">{{ t('summary.progress') }}</span>
        <span class="text-xs tabular-nums text-ink-muted">{{ t('summary.percentDone', { percent: percentDone }) }}</span>
      </div>
      <div class="mt-3 h-1.5 overflow-hidden rounded-chip bg-surface-muted">
        <div data-test="progress" class="h-full progress-fill rounded-chip transition-[width] duration-500" :style="{ width: percentDone + '%' }"></div>
      </div>
      <div v-if="budget.day !== null && dayCost !== null" data-test="day-cost" class="mt-2 text-xs tabular-nums text-ink-muted">{{ t('summary.today', { cost: formatChartValue(dayCost, 'cost'), threshold: formatChartValue(budget.day, 'cost') }) }}<template v-if="dayPartial"> · <span data-test="day-partial">{{ t('summary.todayPartial') }}</span></template></div>
    </div>
  </div>
</template>
