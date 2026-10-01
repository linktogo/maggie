<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from 'chart.js';
import { tokenTotal } from './useHistoryStats.js';
import { useI18n } from './i18n.js';
import { seriesColors, chartInk, chartGrid } from './chartColors.js';
import { formatChartValue } from './chartFormat.js';
import { useTheme } from './theme.js';

const { t, locale } = useI18n();
const { theme, mode: themeMode } = useTheme();

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps({
  totals: { type: Array, required: true }, // [{ repo, tokens, costByModel }]
  mode: { type: String, required: true }, // 'tokens' | 'cost'
});

function costTotal(costByModel) {
  return Object.values(costByModel).reduce((sum, c) => sum + c, 0);
}

const values = computed(() => (props.mode === 'tokens'
  ? props.totals.map((t) => tokenTotal(t.tokens))
  : props.totals.map((t) => Number(costTotal(t.costByModel).toFixed(4)))));

// One row per project, with a floor so a single bar does not fill the card.
const height = computed(() => `${Math.max(160, props.totals.length * 32 + 48)}px`);

const canvas = ref(null);
let chart = null;

function render() {
  const options = { el: canvas.value ?? undefined };
  const ink = chartInk(options);
  const grid = chartGrid(options);
  const format = (value) => formatChartValue(value, props.mode);
  const config = {
    type: 'bar',
    data: {
      labels: props.totals.map((t) => t.repo),
      datasets: [{
        label: props.mode === 'tokens' ? t('history.modeTokens') : t('chart.cost'),
        backgroundColor: seriesColors(options)[0],
        data: values.value,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      // The container height follows the project count (see `height`), so the
      // canvas must fill it rather than keep Chart.js's default 2:1 ratio.
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink, callback: format } },
        y: { grid: { display: false }, ticks: { color: ink } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => format(item.raw) } },
      },
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
watch([() => props.totals, () => props.mode, locale, theme, themeMode], render);
onUnmounted(() => { chart?.destroy(); chart = null; });
</script>

<template>
  <div class="relative" :style="{ height }">
    <canvas ref="canvas" data-test="project-bar-canvas"></canvas>
    <p v-if="totals.length === 0" class="absolute inset-0 flex items-center justify-center text-xs text-ink-faint">
      {{ t('history.empty') }}
    </p>
  </div>
</template>
