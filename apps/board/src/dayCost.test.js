import { test, expect } from 'vitest';
import { dayTotal } from './dayCost.js';
import { USD_TO_EUR } from './pricing.js';

const ONE_M = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const sonnet = { ...ONE_M, byModel: { 'claude-sonnet-5': ONE_M } }; // 3 USD
const at = (d, h) => new Date(2026, 9, d, h).getTime();
const iso = (d, h) => new Date(2026, 9, d, h).toISOString();

test('dayTotal counts history entries that ended on the same local day, not other days', () => {
  const entries = [
    { endedAt: iso(26, 9), usage: sonnet },
    { endedAt: iso(25, 23), usage: sonnet },
    { endedAt: iso(27, 1), usage: sonnet },
  ];
  expect(dayTotal({}, entries, at(26, 15))).toBeCloseTo(3 * USD_TO_EUR, 6);
});

test('dayTotal adds the cost of every live session', () => {
  const repos = { a: { sessions: { s1: { usage: sonnet }, s2: { usage: sonnet } } }, b: { sessions: { s3: { usage: sonnet } } } };
  expect(dayTotal(repos, [], at(26, 15))).toBeCloseTo(9 * USD_TO_EUR, 6);
});

test('dayTotal ignores sessions and entries without usage, and repos without sessions', () => {
  const repos = { a: { sessions: { s1: { usage: null }, s2: {} } }, b: {} };
  const entries = [{ endedAt: iso(26, 9) }, { endedAt: iso(26, 9), usage: null }];
  expect(dayTotal(repos, entries, at(26, 15))).toBe(0);
});

test('dayTotal ignores an entry whose endedAt is missing or unparsable', () => {
  expect(dayTotal({}, [{ usage: sonnet }, { endedAt: 'nope', usage: sonnet }], at(26, 15))).toBe(0);
});

test('dayTotal does not count a closed session twice while it is briefly in both the board and the history', () => {
  const repos = { a: { sessions: { s1: { usage: sonnet } } } };
  const entries = [{ repo: 'a', sessionId: 's1', endedAt: iso(26, 9), usage: sonnet }];
  expect(dayTotal(repos, entries, at(26, 15))).toBeCloseTo(3 * USD_TO_EUR, 6);
});

test('dayTotal still counts a same-id session of another repo', () => {
  const repos = { a: { sessions: { s1: { usage: sonnet } } } };
  const entries = [{ repo: 'b', sessionId: 's1', endedAt: iso(26, 9), usage: sonnet }];
  expect(dayTotal(repos, entries, at(26, 15))).toBeCloseTo(6 * USD_TO_EUR, 6);
});
