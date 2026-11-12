import { test, expect, afterEach } from 'vitest';
import { costText, costTitle } from './costDisplay.js';
import { formatChartValue } from './chartFormat.js';
import { translate, locale, DEFAULT_LOCALE } from './i18n.js';

afterEach(() => { locale.value = DEFAULT_LOCALE; });

function described(overrides = {}) {
  return {
    cost: 1.5, estimate: false, cacheRate: null, lowCache: false,
    byModel: [{ model: 'claude-sonnet-5', cost: 1.5 }],
    ...overrides,
  };
}

test('costText is the formatted amount, prefixed with "~" when estimated', () => {
  expect(costText(described())).toBe(formatChartValue(1.5, 'cost'));
  expect(costText(described({ estimate: true }))).toBe(`~${formatChartValue(1.5, 'cost')}`);
});

test('costTitle lists the per-model breakdown only when nothing else applies', () => {
  const d = described({ byModel: [{ model: 'a', cost: 1 }, { model: 'b', cost: 0.5 }] });
  expect(costTitle(d)).toBe(translate('session.costTooltip', {
    breakdown: `a ${formatChartValue(1, 'cost')} · b ${formatChartValue(0.5, 'cost')}`,
  }));
});

test('costTitle adds the estimate hint, the cache rate and the low-cache warning on their own lines', () => {
  const lines = costTitle(described({ estimate: true, cacheRate: 0.123, lowCache: true })).split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[1]).toBe(translate('session.estimateHint'));
  expect(lines[2]).toBe(translate('session.cacheRate', { rate: 12 }));
  expect(lines[3]).toBe(translate('session.cacheLow'));
});

test('costTitle shows a cache rate of 0 % (a rate of zero is not "no rate")', () => {
  const lines = costTitle(described({ cacheRate: 0 })).split('\n');
  expect(lines).toEqual([expect.any(String), translate('session.cacheRate', { rate: 0 })]);
});
