import { test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import BudgetSettings from './BudgetSettings.vue';
import { budget, setBudget } from './budget.js';

beforeEach(() => { setBudget({ session: null, day: null }); });

async function type(wrapper, selector, value) {
  const input = wrapper.get(selector);
  await input.setValue(value);
  await input.trigger('change');
}

test('entering a session threshold stores it', async () => {
  const w = mount(BudgetSettings);
  await type(w, '[data-test=budget-session]', '5');
  expect(budget.value.session).toBe(5);
});

test('clearing the session input turns that threshold off', async () => {
  setBudget({ session: 5 });
  const w = mount(BudgetSettings);
  await type(w, '[data-test=budget-session]', '');
  expect(budget.value.session).toBeNull();
});

test('an invalid value leaves the previous threshold in place', async () => {
  setBudget({ session: 5 });
  const w = mount(BudgetSettings);
  await type(w, '[data-test=budget-session]', '-1');
  expect(budget.value.session).toBe(5);
});

test('the day input drives the day threshold and leaves the session one alone', async () => {
  setBudget({ session: 5 });
  const w = mount(BudgetSettings);
  await type(w, '[data-test=budget-day]', '40');
  expect(budget.value).toEqual({ session: 5, day: 40 });
});

test('the inputs start from the stored thresholds', () => {
  setBudget({ session: 5, day: 40 });
  const w = mount(BudgetSettings);
  expect(w.get('[data-test=budget-session]').element.value).toBe('5');
  expect(w.get('[data-test=budget-day]').element.value).toBe('40');
});
