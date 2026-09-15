import { test, expect } from 'vitest';
import { initials, visibleBadges, pillClass, ciAggregate, matchesCiFilter } from './ciBadge.js';

test('initials handles single names, separators and empties', () => {
  expect(initials('fabien')).toBe('FA');
  expect(initials('jean-luc')).toBe('JL');
  expect(initials('mary_ann_smith')).toBe('MA');
  expect(initials('a')).toBe('A');
  expect(initials('')).toBe('?');
});

test('visibleBadges sorts worst first and breaks ties by login', () => {
  const users = {
    zoe: { state: 'success' }, alice: { state: 'failure' },
    bob: { state: 'running' }, carl: { state: 'neutral' }, amy: { state: 'failure' },
  };
  const { shown, overflow } = visibleBadges(users);
  expect(shown.map((b) => b.login)).toEqual(['alice', 'amy', 'bob', 'carl']);
  expect(overflow.map((b) => b.login)).toEqual(['zoe']);
  expect(shown[0].initials).toBe('AL');
});

test('visibleBadges returns no overflow at or below the cap', () => {
  const { shown, overflow } = visibleBadges({ a: { state: 'success' } });
  expect(shown).toHaveLength(1);
  expect(overflow).toEqual([]);
});

test('visibleBadges tolerates an absent users map', () => {
  expect(visibleBadges(undefined)).toEqual({ shown: [], overflow: [] });
});

test('pillClass colours each state and falls back to neutral', () => {
  expect(pillClass('failure')).toContain('ci-failure');
  expect(pillClass('running')).toContain('animate-pulse');
  expect(pillClass('success')).toContain('ci-success');
  expect(pillClass('neutral')).toContain('ci-neutral');
  expect(pillClass('bogus')).toBe(pillClass('neutral'));
});

test('ciAggregate reduces contributors to one verdict', () => {
  expect(ciAggregate({})).toBe('unknown');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'failure' } })).toBe('failure');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'running' } })).toBe('running');
  expect(ciAggregate({ a: { state: 'success' }, b: { state: 'neutral' } })).toBe('ok');
});

// Deliberate per the design: "OK = at least one contributor and none failing
// or running". A repo where every latest run was cancelled/skipped (neutral)
// still counts as ok — unintuitive, so pin it explicitly.
test('ciAggregate always agrees with the worst badge visibleBadges shows first', () => {
  const cases = [
    { alice: { state: 'failure' }, bob: { state: 'success' } },
    { alice: { state: 'running' }, bob: { state: 'neutral' } },
    { alice: { state: 'neutral' }, bob: { state: 'success' } },
    { alice: { state: 'success' } },
  ];
  for (const users of cases) {
    const worst = visibleBadges(users).shown[0].state;
    const expected = worst === 'failure' || worst === 'running' ? worst : 'ok';
    expect(ciAggregate(users)).toBe(expected);
  }
});

test('ciAggregate treats an all-neutral repo as ok', () => {
  expect(ciAggregate({ a: { state: 'neutral' }, b: { state: 'neutral' } })).toBe('ok');
});

test('matchesCiFilter implements the three filter options', () => {
  const failing = { a: { state: 'failure' } };
  const green = { a: { state: 'success' } };
  expect(matchesCiFilter(failing, '')).toBe(true);
  expect(matchesCiFilter(failing, 'failure')).toBe(true);
  expect(matchesCiFilter(green, 'failure')).toBe(false);
  expect(matchesCiFilter(green, 'ok')).toBe(true);
  expect(matchesCiFilter({ a: { state: 'running' } }, 'ok')).toBe(false);
  expect(matchesCiFilter({}, 'unknown')).toBe(true);
  expect(matchesCiFilter(green, 'unknown')).toBe(false);
});
