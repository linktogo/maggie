import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TimeSeriesChart from './TimeSeriesChart.vue';
import { DEFAULT_THEME, DEFAULT_MODE, theme, mode, setTheme } from './theme.js';

const chartInstances = [];
let updateCallCount = 0;
vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor(canvas, config) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      chartInstances.push(this);
    }
    update() { updateCallCount += 1; }
    destroy() { this.destroyed = true; }
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

function updateCalls() { return updateCallCount; }

afterEach(() => {
  chartInstances.length = 0;
  updateCallCount = 0;
  vi.restoreAllMocks();
  theme.value = DEFAULT_THEME;
  mode.value = DEFAULT_MODE;
  window.localStorage.clear();
  // setTheme() stamps the real document — resetting the refs above doesn't
  // undo that, the way ThemeSwitcher.test.js resets document.documentElement.
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
});

function bucket(overrides = {}) {
  return {
    key: '2026-08-01',
    tokens: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    costByModel: { 'claude-sonnet-5': 0.01 },
    ...overrides,
  };
}

test('renders one stacked dataset per token type in tokens mode', () => {
  mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  const chart = chartInstances[0];
  expect(chart.data.labels).toEqual(['2026-08-01']);
  expect(chart.data.datasets.map((d) => d.label)).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
  expect(chart.data.datasets[0].data).toEqual([10]);
  expect(chart.options.scales.x.stacked).toBe(true);
});

test('renders one dataset per model in cost mode, labeling a missing model as "Unknown model"', () => {
  mount(TimeSeriesChart, {
    props: {
      buckets: [bucket({ costByModel: { 'claude-sonnet-5': 0.02, unknown: 0.01 } })],
      mode: 'cost',
    },
  });
  const chart = chartInstances[0];
  expect(chart.data.datasets.map((d) => d.label).sort()).toEqual(['Unknown model', 'claude-sonnet-5']);
});

test('re-renders (not re-creates) the chart when buckets or mode change', async () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  await wrapper.setProps({ buckets: [bucket({ key: '2026-08-02' })], mode: 'tokens' });
  expect(chartInstances).toHaveLength(1); // same instance, updated in place
  expect(chartInstances[0].data.labels).toEqual(['2026-08-02']);
});

test('destroys the chart instance on unmount', () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [bucket()], mode: 'tokens' } });
  const chart = chartInstances[0];
  wrapper.unmount();
  expect(chart.destroyed).toBe(true);
});

test('shows an empty-state message when there are no buckets', () => {
  const wrapper = mount(TimeSeriesChart, { props: { buckets: [], mode: 'tokens' } });
  expect(wrapper.text()).toContain('No completed session yet');
});

test('re-renders when the theme changes', async () => {
  const w = mount(TimeSeriesChart, { props: { buckets: [], mode: 'tokens' } });
  const before = updateCalls();
  setTheme('classic', { storage: window.localStorage, doc: document });
  await nextTick();
  expect(updateCalls()).toBeGreaterThan(before);
  w.unmount();
});
