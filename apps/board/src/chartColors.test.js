import { test, expect } from 'vitest';
import { tokenColor, seriesColors, chartInk, FALLBACK } from './chartColors.js';

// Stands in for getComputedStyle: returns whatever the theme is supposed to
// have resolved for each custom property.
function computedFrom(values) {
  return () => ({ getPropertyValue: (name) => values[name] ?? '' });
}

test('reads a token from the resolved styles', () => {
  const computed = computedFrom({ '--color-series-1': ' #6750a4 ' });
  expect(tokenColor('--color-series-1', { computed })).toBe('#6750a4');
});

test('falls back when the property resolves empty, as it does in jsdom', () => {
  expect(tokenColor('--color-series-1', { computed: computedFrom({}) })).toBe(FALLBACK['--color-series-1']);
});

test('falls back when there is no getComputedStyle at all', () => {
  expect(tokenColor('--color-series-2', { computed: undefined })).toBe(FALLBACK['--color-series-2']);
});

test('returns the six series colors in order', () => {
  const computed = computedFrom({
    '--color-series-1': '#111111', '--color-series-2': '#222222', '--color-series-3': '#333333',
    '--color-series-4': '#444444', '--color-series-5': '#555555', '--color-series-6': '#666666',
  });
  expect(seriesColors({ computed })).toEqual(['#111111', '#222222', '#333333', '#444444', '#555555', '#666666']);
});

test('chart text follows the muted ink token', () => {
  const computed = computedFrom({ '--color-ink-muted': '#605d66' });
  expect(chartInk({ computed })).toBe('#605d66');
});
