import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ProjectBarChart from './ProjectBarChart.vue';

const chartInstances = [];
vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor(canvas, config) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      chartInstances.push(this);
    }
    update() {}
    destroy() { this.destroyed = true; }
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => { chartInstances.length = 0; vi.restoreAllMocks(); });

function total(overrides = {}) {
  return {
    repo: 'oc-be',
    tokens: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    costByModel: { 'claude-sonnet-5': 0.05 },
    ...overrides,
  };
}

test('renders one horizontal bar per project in tokens mode', () => {
  mount(ProjectBarChart, {
    props: {
      totals: [total(), total({ repo: 'other', tokens: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } })],
      mode: 'tokens',
    },
  });
  const chart = chartInstances[0];
  expect(chart.data.labels).toEqual(['oc-be', 'other']);
  expect(chart.data.datasets[0].data).toEqual([36, 4]);
  expect(chart.options.indexAxis).toBe('y');
});

test('renders the summed cost across models in cost mode', () => {
  mount(ProjectBarChart, {
    props: { totals: [total({ costByModel: { 'claude-sonnet-5': 0.05, unknown: 0.02 } })], mode: 'cost' },
  });
  const chart = chartInstances[0];
  expect(chart.data.datasets[0].data).toEqual([0.07]);
  expect(chart.data.datasets[0].label).toBe('Cost (€)');
});

test('re-renders (not re-creates) the chart when totals or mode change', async () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [total()], mode: 'tokens' } });
  await wrapper.setProps({ totals: [total({ repo: 'other' })], mode: 'tokens' });
  expect(chartInstances).toHaveLength(1);
  expect(chartInstances[0].data.labels).toEqual(['other']);
});

test('destroys the chart instance on unmount', () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [total()], mode: 'tokens' } });
  const chart = chartInstances[0];
  wrapper.unmount();
  expect(chart.destroyed).toBe(true);
});

test('shows an empty-state message when there are no totals', () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [], mode: 'tokens' } });
  expect(wrapper.text()).toContain('No completed session yet');
});

test('grows with the project count and fills that height', () => {
  const totals = Array.from({ length: 10 }, (_, i) => total({ repo: `r${i}` }));
  const wrapper = mount(ProjectBarChart, { props: { totals, mode: 'tokens' } });
  expect(chartInstances[0].options.maintainAspectRatio).toBe(false);
  expect(wrapper.find('div').attributes('style')).toContain('height: 368px');
});

test('keeps a minimum height for a single project', () => {
  const wrapper = mount(ProjectBarChart, { props: { totals: [total()], mode: 'tokens' } });
  expect(wrapper.find('div').attributes('style')).toContain('height: 160px');
});

test('formats ticks and tooltips by mode', () => {
  mount(ProjectBarChart, { props: { totals: [total()], mode: 'cost' } });
  const { options } = chartInstances[0];
  expect(options.scales.x.ticks.callback(0.5)).toBe('0.50 €');
  expect(options.plugins.tooltip.callbacks.label({ raw: 2 })).toBe('2.00 €');
});
