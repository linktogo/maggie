import { test, expect } from 'vitest';
import { ref } from 'vue';
import { useHistoryStats, bucketKey } from './useHistoryStats.js';
import { USD_TO_EUR } from './pricing.js';

function entry(overrides = {}) {
  return {
    repo: 'oc-be',
    sessionId: 's1',
    endedAt: '2026-08-07T19:42:41.721Z',
    usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 },
    ...overrides,
  };
}

test('bucketKey buckets by day/week/month/year in UTC', () => {
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'day')).toBe('2026-08-07');
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'week')).toBe('2026-08-03'); // Monday of that week
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'month')).toBe('2026-08');
  expect(bucketKey('2026-08-07T19:42:41.721Z', 'year')).toBe('2026');
});

test('bucketKey\'s week bucket crosses a year boundary correctly', () => {
  expect(bucketKey('2026-01-01T00:00:00.000Z', 'week')).toBe('2025-12-29'); // Monday of the week containing Jan 1 2026
});

test('bucketByPeriod groups entries into sorted, token-summed buckets', () => {
  const entries = ref([
    entry({ sessionId: 's1', endedAt: '2026-08-07T10:00:00.000Z', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } }),
    entry({ sessionId: 's2', endedAt: '2026-08-07T20:00:00.000Z', usage: { inputTokens: 2, outputTokens: 2, cacheCreationInputTokens: 2, cacheReadInputTokens: 2 } }),
    entry({ sessionId: 's3', endedAt: '2026-08-08T10:00:00.000Z', usage: { inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  const buckets = bucketByPeriod('day');
  expect(buckets.map((b) => b.key)).toEqual(['2026-08-07', '2026-08-08']);
  expect(buckets[0].tokens).toEqual({ inputTokens: 3, outputTokens: 3, cacheCreationInputTokens: 3, cacheReadInputTokens: 3 });
  expect(buckets[1].tokens).toEqual({ inputTokens: 5, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
});

test('bucketByPeriod excludes entries with no endedAt (nothing to bucket by)', () => {
  const entries = ref([
    entry({ sessionId: 's1', endedAt: null }),
    entry({ sessionId: 's2', endedAt: '2026-08-07T10:00:00.000Z' }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  expect(bucketByPeriod('day')).toHaveLength(1);
});

test('bucketByPeriod attributes cost per model, and pre-migration entries with no byModel go under "unknown"', () => {
  const entries = ref([
    entry({
      sessionId: 's1',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, byModel: { 'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } },
    }),
    entry({
      sessionId: 's2',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, // no byModel at all
    }),
  ]);
  const { bucketByPeriod } = useHistoryStats(entries);
  const [bucket] = bucketByPeriod('day');
  expect(bucket.costByModel['claude-sonnet-5']).toBeCloseTo(3 * USD_TO_EUR, 6);
  expect(bucket.costByModel.unknown).toBeCloseTo(3 * USD_TO_EUR, 6);
  expect(Object.keys(bucket.costByModel).sort()).toEqual(['claude-sonnet-5', 'unknown']);
});

test('totalsByProject aggregates every entry by repo, regardless of granularity, sorted by token volume descending', () => {
  const entries = ref([
    entry({ repo: 'a', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 } }),
    entry({ repo: 'b', sessionId: 's2', usage: { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
    entry({ repo: 'a', sessionId: 's3', usage: { inputTokens: 2, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
  ]);
  const { totalsByProject } = useHistoryStats(entries);
  const totals = totalsByProject();
  expect(totals.map((t) => t.repo)).toEqual(['b', 'a']);
  expect(totals[1].tokens).toEqual({ inputTokens: 3, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1 });
});

test('totalsByProject includes entries with no endedAt (only time-bucketing needs a timestamp)', () => {
  const entries = ref([entry({ repo: 'a', endedAt: null })]);
  const { totalsByProject } = useHistoryStats(entries);
  expect(totalsByProject()).toHaveLength(1);
});
