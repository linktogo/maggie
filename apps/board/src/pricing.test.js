import { test, expect } from 'vitest';
import { PRICING, USD_TO_EUR, costByModel, costOf, isEstimate, rateFor } from './pricing.js';

function usage(overrides = {}) {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, ...overrides };
}

test('costByModel prices a single model at its own rate', () => {
  const result = costByModel({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(result['claude-sonnet-5']).toBeCloseTo(22.05 * USD_TO_EUR, 6); // 3 + 15 + 3.75 + 0.3 USD, from PRICING['claude-sonnet-5']
});

test('costByModel prices multiple models independently and does not blend rates', () => {
  const result = costByModel({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      'claude-opus-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(result['claude-sonnet-5']).toBeCloseTo(22.05 * USD_TO_EUR, 6);
  expect(result['claude-opus-5']).toBeCloseTo(110.25 * USD_TO_EUR, 6);
});

test('costByModel falls back to the default rate under an "unknown" key when byModel is empty', () => {
  const result = costByModel({ ...usage({ inputTokens: 1_000_000 }), byModel: {} });
  expect(result.unknown).toBeCloseTo(3 * USD_TO_EUR, 6); // PRICING.default.input
});

test('costByModel falls back to the default rate under an "unknown" key when byModel is absent (pre-migration entries)', () => {
  const result = costByModel(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  expect(result.unknown).toBeCloseTo(18 * USD_TO_EUR, 6); // 3 + 15, PRICING.default
});

test('costByModel returns an empty object for null/undefined usage', () => {
  expect(costByModel(null)).toEqual({});
  expect(costByModel(undefined)).toEqual({});
});

test('costByModel prices an unrecognized model name at the default rate, keyed by its own name', () => {
  const result = costByModel({ byModel: { 'some-future-model': usage({ inputTokens: 1_000_000 }) } });
  expect(result['some-future-model']).toBeCloseTo(3 * USD_TO_EUR, 6);
});

test('costOf sums every model bucket from costByModel into one total', () => {
  const total = costOf({
    byModel: {
      'claude-sonnet-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      'claude-opus-5': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    },
  });
  expect(total).toBeCloseTo(132.3 * USD_TO_EUR, 6);
});

test('costOf returns 0 for null usage', () => {
  expect(costOf(null)).toBe(0);
});

test('rateFor returns the exact entry for a listed model id', () => {
  expect(rateFor('claude-sonnet-5')).toEqual(PRICING['claude-sonnet-5']);
  expect(rateFor('claude-haiku-4-5-20251001')).toEqual(PRICING['claude-haiku-4-5-20251001']);
});

test('rateFor matches a longer id by family prefix on a "-" boundary', () => {
  expect(rateFor('claude-sonnet-5-5')).toEqual(PRICING['claude-sonnet-5']);
  expect(rateFor('claude-opus-5-5')).toEqual(PRICING['claude-opus-5']);
});

test('rateFor never matches across a non-boundary, an embedded name, "default" or a foreign model', () => {
  expect(rateFor('claude-sonnet-50')).toBeNull();
  expect(rateFor('my-claude-sonnet-5')).toBeNull();
  expect(rateFor('default')).toBeNull();
  expect(rateFor('gpt-5')).toBeNull();
});

test('costByModel prices a family-prefixed id at its family rate', () => {
  const result = costByModel({ byModel: { 'claude-sonnet-5-5': usage({ inputTokens: 1_000_000 }) } });
  expect(result['claude-sonnet-5-5']).toBeCloseTo(3 * USD_TO_EUR, 6);
});

test('isEstimate is false when every model resolves to a table entry', () => {
  expect(isEstimate({ byModel: { 'claude-sonnet-5': usage({ inputTokens: 1 }), 'claude-opus-5-5': usage({ inputTokens: 1 }) } })).toBe(false);
});

test('isEstimate is true when any model falls back to the default rate', () => {
  expect(isEstimate({ byModel: { 'claude-sonnet-5': usage({ inputTokens: 1 }), 'gpt-5': usage({ inputTokens: 1 }) } })).toBe(true);
});

test('isEstimate is true for usage without a byModel breakdown, false for null', () => {
  expect(isEstimate(usage({ inputTokens: 1 }))).toBe(true);
  expect(isEstimate({ ...usage({ inputTokens: 1 }), byModel: {} })).toBe(true);
  expect(isEstimate(null)).toBe(false);
});
