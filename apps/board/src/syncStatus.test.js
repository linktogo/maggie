import { test, expect } from 'vitest';
import { countSync, matchesSyncFilter, syncState } from './syncStatus.js';

test('syncState maps a check result to a state', () => {
  expect(syncState(null)).toBe('unknown');
  expect(syncState(undefined)).toBe('unknown');
  expect(syncState({ status: 'in-sync' })).toBe('in-sync');
  expect(syncState({ status: 'drift' })).toBe('drift');
  expect(syncState({ status: 'error', error: 'x' })).toBe('error');
  expect(syncState({ status: 'pushed' })).toBe('error');
});

test('matchesSyncFilter keeps everything without a filter, else matches the state', () => {
  expect(matchesSyncFilter(null, '')).toBe(true);
  expect(matchesSyncFilter({ status: 'drift' }, 'drift')).toBe(true);
  expect(matchesSyncFilter({ status: 'in-sync' }, 'drift')).toBe(false);
  expect(matchesSyncFilter(null, 'unknown')).toBe(true);
});

test('countSync counts drifted and failed repos among the given names only', () => {
  const sync = { a: { status: 'drift' }, b: { status: 'error' }, c: { status: 'in-sync' }, d: { status: 'drift' } };
  expect(countSync(sync, ['a', 'b', 'c', 'x'])).toEqual({ drift: 1, error: 1 });
});
