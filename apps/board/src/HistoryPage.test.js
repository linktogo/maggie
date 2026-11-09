import { test, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HistoryPage from './HistoryPage.vue';
import TimeSeriesChart from './TimeSeriesChart.vue';
import ProjectBarChart from './ProjectBarChart.vue';

vi.mock('chart.js', () => {
  class Chart {
    static register() {}
    constructor() {}
    update() {}
    destroy() {}
  }
  return { Chart, BarController: {}, BarElement: {}, CategoryScale: {}, LinearScale: {}, Tooltip: {}, Legend: {} };
});

afterEach(() => { vi.restoreAllMocks(); });

function entry(overrides = {}) {
  return {
    repo: 'oc-be', sessionId: 's1', title: 'fix login',
    startedAt: null, endedAt: '2026-08-07T10:00:00.000Z',
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function fetchImplWith(entries) {
  return vi.fn().mockResolvedValue({ json: async () => entries });
}

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

test('defaults to the "By period" tab with day granularity, and always renders the table below', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(true);
  expect(wrapper.findComponent(ProjectBarChart).exists()).toBe(false);
  expect(wrapper.text()).toContain('fix login'); // HistoryTable row
});

test('switching to the "By project" tab shows the project chart instead of the time series', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  await wrapper.get('[data-test=tab-project]').trigger('click');
  await settle();
  expect(wrapper.findComponent(ProjectBarChart).exists()).toBe(true);
  expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(false);
});

test('changing granularity re-buckets the time-series chart', async () => {
  const wrapper = mount(HistoryPage, {
    props: { fetchImpl: fetchImplWith([entry(), entry({ sessionId: 's2', endedAt: '2026-09-01T10:00:00.000Z' })]) },
  });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(2); // two different days
  await wrapper.get('[data-test=granularity-month]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(2); // two different months too
  await wrapper.get('[data-test=granularity-year]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('buckets')).toHaveLength(1); // same year
});

test('the € toggle switches the active chart into cost mode', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('mode')).toBe('tokens');
  await wrapper.get('[data-test=mode-cost]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('mode')).toBe('cost');
});

test('the project chart reflects the mode toggle too', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  await wrapper.get('[data-test=tab-project]').trigger('click');
  await wrapper.get('[data-test=mode-cost]').trigger('click');
  await settle();
  expect(wrapper.findComponent(ProjectBarChart).props('mode')).toBe('cost');
});

test('the period tab and the tokens toggle switch back from project and cost', async () => {
  const wrapper = mount(HistoryPage, { props: { fetchImpl: fetchImplWith([entry()]) } });
  await settle();
  await wrapper.get('[data-test=tab-project]').trigger('click');
  await wrapper.get('[data-test=mode-cost]').trigger('click');
  await wrapper.get('[data-test=tab-period]').trigger('click');
  await wrapper.get('[data-test=mode-tokens]').trigger('click');
  await settle();
  expect(wrapper.findComponent(TimeSeriesChart).props('mode')).toBe('tokens');
  expect(wrapper.findComponent(ProjectBarChart).exists()).toBe(false);
});
