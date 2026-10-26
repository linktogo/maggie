import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SummaryHeader from './SummaryHeader.vue';
import { setBudget } from './budget.js';
import { formatChartValue } from './chartFormat.js';
import { translate } from './i18n.js';

const repos = {
  a: { sessions: {} }, // idle repo -> counts as one "todo" card
  b: { sessions: { s1: { status: 'inprogress' } } },
  c: { sessions: { s2: { status: 'question' } } },
  d: { sessions: { s3: { status: 'done' }, s4: { status: 'done' } } }, // two sessions on one repo
};

test('shows total and per-status counts', () => {
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.text()).toContain('5');         // total: a(1) + b(1) + c(1) + d(2)
  expect(w.text()).toContain('1 Question');
  expect(w.text()).toContain('2 Done');
});

test('computes the done percentage', () => {
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.text()).toContain('40 %');       // 2 of 5
  expect(w.get('[data-test=progress]').attributes('style')).toContain('40%');
});

test('handles an empty board without dividing by zero', () => {
  const w = mount(SummaryHeader, { props: { repos: {} } });
  expect(w.text()).toContain('0 %');
});

test('shows no day cost line when no day threshold is set', () => {
  setBudget({ day: null });
  const w = mount(SummaryHeader, { props: { repos, dayCost: 12 } });
  expect(w.find('[data-test=day-cost]').exists()).toBe(false);
});

test('shows today\'s cost against the day threshold when one is set', () => {
  setBudget({ day: 50 });
  const w = mount(SummaryHeader, { props: { repos, dayCost: 12 } });
  expect(w.get('[data-test=day-cost]').text()).toBe(translate('summary.today', {
    cost: formatChartValue(12, 'cost'), threshold: formatChartValue(50, 'cost'),
  }));
  setBudget({ day: null });
});

test('shows no day cost line while the day total is unknown', () => {
  setBudget({ day: 50 });
  const w = mount(SummaryHeader, { props: { repos } });
  expect(w.find('[data-test=day-cost]').exists()).toBe(false);
  setBudget({ day: null });
});
