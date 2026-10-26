import { test, expect, beforeEach } from 'vitest';
import { BUDGET_KEY, alertLevel, budget, readBudget, setBudget } from './budget.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

beforeEach(() => { setBudget({ session: null, day: null }, memoryStorage()); });

test('readBudget is off when nothing is stored', () => {
  expect(readBudget(memoryStorage())).toEqual({ session: null, day: null });
});

test('readBudget reads stored thresholds', () => {
  const storage = memoryStorage({ [BUDGET_KEY]: JSON.stringify({ session: 5, day: 50 }) });
  expect(readBudget(storage)).toEqual({ session: 5, day: 50 });
});

test('readBudget treats invalid JSON as off', () => {
  expect(readBudget(memoryStorage({ [BUDGET_KEY]: '{nope' }))).toEqual({ session: null, day: null });
});

test('readBudget treats a throwing storage as off', () => {
  const storage = { getItem() { throw new Error('blocked'); } };
  expect(readBudget(storage)).toEqual({ session: null, day: null });
});

test('readBudget drops a non-positive or non-numeric field but keeps the other', () => {
  const storage = memoryStorage({ [BUDGET_KEY]: JSON.stringify({ session: -1, day: 20 }) });
  expect(readBudget(storage)).toEqual({ session: null, day: 20 });
  expect(readBudget(memoryStorage({ [BUDGET_KEY]: JSON.stringify({ session: '5', day: 0 }) }))).toEqual({ session: null, day: null });
});

test('setBudget sets one field, keeps the other, and persists', () => {
  const storage = memoryStorage();
  setBudget({ session: 5 }, storage);
  setBudget({ day: 40 }, storage);
  expect(budget.value).toEqual({ session: 5, day: 40 });
  expect(JSON.parse(storage.data[BUDGET_KEY])).toEqual({ session: 5, day: 40 });
});

test('setBudget clears a field with null', () => {
  const storage = memoryStorage();
  setBudget({ session: 5, day: 40 }, storage);
  setBudget({ session: null }, storage);
  expect(budget.value).toEqual({ session: null, day: 40 });
});

test('setBudget ignores a value that is not a finite number above zero, keeping the previous one', () => {
  const storage = memoryStorage();
  setBudget({ session: 5 }, storage);
  for (const bad of [Number.NaN, 0, -3, 'abc', Infinity]) setBudget({ session: bad }, storage);
  expect(budget.value.session).toBe(5);
});

test('setBudget still updates the held value when storage throws', () => {
  const storage = { getItem: () => null, setItem() { throw new Error('quota'); } };
  setBudget({ day: 12 }, storage);
  expect(budget.value.day).toBe(12);
});

test('alertLevel is 0 below the threshold or with no threshold', () => {
  expect(alertLevel(0.9, 1)).toBe(0);
  expect(alertLevel(5, null)).toBe(0);
  expect(alertLevel(5, 0)).toBe(0);
});

test('alertLevel rises at the threshold and at each doubling', () => {
  expect(alertLevel(1, 1)).toBe(1);
  expect(alertLevel(1.99, 1)).toBe(1);
  expect(alertLevel(2, 1)).toBe(2);
  expect(alertLevel(4.5, 1)).toBe(3);
});
