import { test, expect } from 'vitest';
import { afterEach } from 'vitest';
import { formatChartValue, formatBucketLabel } from './chartFormat.js';
import { DEFAULT_LOCALE, locale } from './i18n.js';

afterEach(() => { locale.value = DEFAULT_LOCALE; });

test('tokens mode uses compact counts', () => {
  expect(formatChartValue(18_000_000, 'tokens')).toBe('18.0M');
  expect(formatChartValue(1500, 'tokens')).toBe('1.5K');
  expect(formatChartValue(0, 'tokens')).toBe('0');
});

test('cost mode shows euros with two decimals, formatted for the selected language', () => {
  expect(formatChartValue(1.2345, 'cost')).toBe('€1.23');
  locale.value = 'fr';
  expect(formatChartValue(1.2345, 'cost')).toBe('1,23\u00a0€');
});

test('bucket keys become localized axis labels', () => {
  expect(formatBucketLabel('2026', 'year')).toBe('2026');
  expect(formatBucketLabel('2026-08', 'month')).toBe('Aug 2026');
  expect(formatBucketLabel('2026-08-16', 'day')).toBe('Aug 16');
  expect(formatBucketLabel('2026-08-10', 'week')).toBe('week of Aug 10');
  locale.value = 'fr';
  expect(formatBucketLabel('2026-08-16', 'day')).toBe('16 août');
  expect(formatBucketLabel('2026-08', 'month')).toBe('août 2026');
  expect(formatBucketLabel('2026-08-10', 'week')).toBe('semaine du 10 août');
});

test('an unparseable bucket key is shown as is', () => {
  expect(formatBucketLabel('nope', 'day')).toBe('nope');
  expect(formatBucketLabel('nope', 'month')).toBe('nope');
});
