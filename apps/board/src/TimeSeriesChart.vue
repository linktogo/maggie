<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { UNKNOWN_MODEL } from './pricing.js';
import { useI18n } from './i18n.js';

const { t, locale } = useI18n();

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps({
  buckets: { type: Array, required: true }, // [{ key, tokens, costByModel }]
  mode: { type: String, required: true }, // 'tokens' | 'cost'
});

const TOKEN_SERIES = [
  { key: 'inputTokens', labelKey: 'chart.input', color: '#2563eb' },
  { key: 'outputTokens', labelKey: 'chart.output', color: '#10b981' },
  { key: 'cacheCreationInputTokens', labelKey: 'chart.cacheWrite', color: '#f59e0b' },
  { key: 'cacheReadInputTokens', labelKey: 'chart.cacheRead', color: '#94a3b8' },
];
const MODEL_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
const UNKNOWN_COLOR = '#94a3b8';

function modelLabel(model) {
  return model === UNKNOWN_MODEL ? t('chart.unknownModel') : model;
}

const modelKeys = computed(() => {
  const keys = new Set();
  for (const b of props.buckets) for (const m of Object.keys(b.costByModel)) keys.add(m);
  return [...keys].sort();
});

const datasets = computed(() => {
  if (props.mode === 'tokens') {
    return TOKEN_SERIES.map((s) => ({
      label: t(s.labelKey),
      backgroundColor: s.color,
      data: props.buckets.map((b) => b.tokens[s.key]),
    }));
  }
  return modelKeys.value.map((model, i) => ({
    label: modelLabel(model),
    backgroundColor: model === UNKNOWN_MODEL ? UNKNOWN_COLOR : MODEL_COLORS[i % MODEL_COLORS.length],
    data: props.buckets.map((b) => Number((b.costByModel[model] ?? 0).toFixed(4))),
  }));
});

const canvas = ref(null);
let chart = null;

function render() {
  const config = {
    type: 'bar',
    data: { labels: props.buckets.map((b) => b.key), datasets: datasets.value },
    options: {
      responsive: true,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom' } },
    },
  };
  if (chart) {
    chart.data = config.data;
    chart.options = config.options;
    chart.update();
  } else {
    chart = new Chart(canvas.value, config);
  }
}

onMounted(render);
watch([() => props.buckets, () => props.mode, locale], render);
onUnmounted(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div class="relative h-64">
    <canvas ref="canvas" data-test="time-series-canvas"></canvas>
    <p v-if="buckets.length === 0" class="absolute inset-0 flex items-center justify-center text-xs text-ink-faint">
      {{ t('history.empty') }}
    </p>
  </div>
</template>
