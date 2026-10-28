import { test, expect } from 'vitest';
import { describeUsage } from './liveUsage.js';
import { costOf } from './pricing.js';

function usage(overrides = {}) {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, ...overrides };
}

test('describeUsage is null for null usage', () => {
  expect(describeUsage(null)).toBeNull();
});

test('describeUsage reports the total cost, per-model costs sorted descending, and no estimate for known models', () => {
  const u = {
    ...usage({ inputTokens: 2_000_000 }),
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000 }),
      'claude-opus-5': usage({ inputTokens: 1_000_000 }),
    },
  };
  const d = describeUsage(u);
  expect(d.cost).toBeCloseTo(costOf(u), 9);
  expect(d.byModel.map((m) => m.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  expect(d.byModel[0].cost).toBeGreaterThan(d.byModel[1].cost);
  expect(d.estimate).toBe(false);
});

test('describeUsage marks an unknown model as an estimate', () => {
  const d = describeUsage({ ...usage({ inputTokens: 1 }), byModel: { 'gpt-5': usage({ inputTokens: 1 }) } });
  expect(d.estimate).toBe(true);
});

test('describeUsage prices usage without byModel under a single unknown entry, as an estimate', () => {
  const d = describeUsage(usage({ inputTokens: 1_000_000 }));
  expect(d.estimate).toBe(true);
  expect(d.byModel).toHaveLength(1);
  expect(d.byModel[0].model).toBe('unknown');
});

test('lowCache is true for a low rate over enough tokens', () => {
  // rate 0.2: 20k read / 100k input-side
  const d = describeUsage(usage({ inputTokens: 80_000, cacheReadInputTokens: 20_000 }));
  expect(d.cacheRate).toBeCloseTo(0.2, 6);
  expect(d.lowCache).toBe(true);
});

test('lowCache is false for a low rate while the session is still small', () => {
  const d = describeUsage(usage({ inputTokens: 8_000, cacheReadInputTokens: 2_000 }));
  expect(d.cacheRate).toBeCloseTo(0.2, 6);
  expect(d.lowCache).toBe(false);
});

test('lowCache is false for a healthy rate, and for no rate at all', () => {
  expect(describeUsage(usage({ inputTokens: 10_000, cacheReadInputTokens: 90_000 })).lowCache).toBe(false);
  const none = describeUsage(usage({ outputTokens: 5 }));
  expect(none.cacheRate).toBeNull();
  expect(none.lowCache).toBe(false);
});
