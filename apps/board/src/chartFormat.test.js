import { test, expect } from 'vitest';
import { formatChartValue } from './chartFormat.js';

test('tokens mode uses compact counts', () => {
  expect(formatChartValue(18_000_000, 'tokens')).toBe('18.0M');
  expect(formatChartValue(1500, 'tokens')).toBe('1.5K');
  expect(formatChartValue(0, 'tokens')).toBe('0');
});

test('cost mode shows euros with two decimals', () => {
  expect(formatChartValue(1.2345, 'cost')).toBe('1.23 €');
});
