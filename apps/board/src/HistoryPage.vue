<script setup>
import { ref, computed } from 'vue';
import { useHistory } from './useHistory.js';
import { useHistoryStats } from './useHistoryStats.js';
import TimeSeriesChart from './TimeSeriesChart.vue';
import ProjectBarChart from './ProjectBarChart.vue';
import HistoryTable from './HistoryTable.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, required: true },
});
const { entries } = useHistory({ fetchImpl: props.fetchImpl });

const mode = ref('tokens'); // 'tokens' | 'cost'
const tab = ref('period'); // 'period' | 'project'
const granularity = ref('day'); // 'day' | 'week' | 'month' | 'year'

const GRANULARITIES = computed(() => ['day', 'week', 'month', 'year'].map(
  (key) => ({ key, label: t(`history.${key}`) }),
));

const { bucketByPeriod, totalsByProject } = useHistoryStats(entries);
const buckets = computed(() => bucketByPeriod(granularity.value));
const projectTotals = computed(() => totalsByProject());

function tabClass(active) {
  return ['rounded-md px-3 py-1 font-medium transition-colors', active ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-700'];
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm" role="tablist">
        <button data-test="tab-period" role="tab" :aria-selected="tab === 'period'" :class="tabClass(tab === 'period')" @click="tab = 'period'">{{ t('history.tabPeriod') }}</button>
        <button data-test="tab-project" role="tab" :aria-selected="tab === 'project'" :class="tabClass(tab === 'project')" @click="tab = 'project'">{{ t('history.tabProject') }}</button>
      </div>
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
        <button data-test="mode-tokens" :class="tabClass(mode === 'tokens')" @click="mode = 'tokens'">{{ t('history.modeTokens') }}</button>
        <button data-test="mode-cost" :class="tabClass(mode === 'cost')" @click="mode = 'cost'">€</button>
      </div>
    </div>

    <div v-if="tab === 'period'" class="bg-white border border-slate-200 rounded-xl shadow-xs p-4">
      <div class="inline-flex bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm mb-3">
        <button
          v-for="g in GRANULARITIES" :key="g.key"
          :data-test="`granularity-${g.key}`"
          :class="tabClass(granularity === g.key)"
          @click="granularity = g.key"
        >{{ g.label }}</button>
      </div>
      <TimeSeriesChart :buckets="buckets" :mode="mode" />
    </div>

    <div v-else class="bg-white border border-slate-200 rounded-xl shadow-xs p-4">
      <ProjectBarChart :totals="projectTotals" :mode="mode" />
    </div>

    <HistoryTable :entries="entries" />
  </div>
</template>
