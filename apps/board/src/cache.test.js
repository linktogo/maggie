import { test, expect } from 'vitest';
import { cacheHitRate, LOW_CACHE_RATE, LOW_CACHE_MIN_TOKENS } from './cache.js';

function usage(overrides = {}) {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, ...overrides };
}

test('cacheHitRate is the share of input-side tokens served from cache', () => {
  expect(cacheHitRate(usage({ inputTokens: 10, cacheCreationInputTokens: 30, cacheReadInputTokens: 60 }))).toBeCloseTo(0.6, 6);
});

test('cacheHitRate ignores output tokens', () => {
  expect(cacheHitRate(usage({ outputTokens: 999, cacheReadInputTokens: 1, inputTokens: 1 }))).toBeCloseTo(0.5, 6);
});

test('cacheHitRate is 1 when everything was read from cache', () => {
  expect(cacheHitRate(usage({ cacheReadInputTokens: 5 }))).toBe(1);
});

test('cacheHitRate is null for null usage and for usage with no input-side tokens', () => {
  expect(cacheHitRate(null)).toBeNull();
  expect(cacheHitRate(usage({ outputTokens: 10 }))).toBeNull();
});

test('the low-rate thresholds match the spec', () => {
  expect(LOW_CACHE_RATE).toBe(0.5);
  expect(LOW_CACHE_MIN_TOKENS).toBe(50_000);
});
