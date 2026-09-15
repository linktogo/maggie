<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { UNKNOWN_MODEL } from './pricing.js';
import { useI18n } from './i18n.js';
import { seriesColors, chartInk } from './chartColors.js';
import { useTheme } from './theme.js';

const { t, locale } = useI18n();
const { theme, mode: themeMode } = useTheme();

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps({
  buckets: { type: Array, required: true }, // [{ key, tokens, costByModel }]
  mode: { type: String, required: true }, // 'tokens' | 'cost'
});

const TOKEN_SERIES = [
  { key: 'inputTokens', labelKey: 'chart.input' },
  { key: 'outputTokens', labelKey: 'chart.output' },
  { key: 'cacheCreationInputTokens', labelKey: 'chart.cacheWrite' },
  { key: 'cacheReadInputTokens', labelKey: 'chart.cacheRead' },
];

function modelLabel(model) {
  return model === UNKNOWN_MODEL ? t('chart.unknownModel') : model;
}

const modelKeys = computed(() => {
  const keys = new Set();
  for (const b of props.buckets) for (const m of Object.keys(b.costByModel)) keys.add(m);
  return [...keys].sort();
});

function buildDatasets(palette) {
  if (props.mode === 'tokens') {
    return TOKEN_SERIES.map((s, i) => ({
      label: t(s.labelKey),
      backgroundColor: palette[i],
      data: props.buckets.map((b) => b.tokens[s.key]),
    }));
  }
  return modelKeys.value.map((model, i) => ({
    label: modelLabel(model),
    // The unknown model keeps the neutral slot rather than taking a hue that
    // would read as a real model.
    backgroundColor: model === UNKNOWN_MODEL ? palette[3] : palette[i % palette.length],
    data: props.buckets.map((b) => Number((b.costByModel[model] ?? 0).toFixed(4))),
  }));
}

const canvas = ref(null);
let chart = null;

function render() {
  const options = { el: canvas.value ?? undefined };
  const palette = seriesColors(options);
  const ink = chartInk(options);
  const config = {
    type: 'bar',
    data: { labels: props.buckets.map((b) => b.key), datasets: buildDatasets(palette) },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: ink } },
        y: { stacked: true, ticks: { color: ink } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: ink } } },
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
watch([() => props.buckets, () => props.mode, locale, theme, themeMode], render);
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
