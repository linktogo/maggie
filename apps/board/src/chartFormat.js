import { formatTokens } from './formatTokens.js';

// Axis ticks and tooltips share one formatter so a bar reads the same on the
// scale and on hover: compact counts in tokens mode, euros in cost mode.
export function formatChartValue(value, mode) {
  if (mode === 'cost') return `${Number(value).toFixed(2)} €`;
  return formatTokens(value);
}
