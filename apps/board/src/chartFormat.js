import { formatTokens } from './formatTokens.js';
import { locale, translate } from './i18n.js';

export function formatChartValue(value, mode) {
  if (mode === 'cost') {
    return Number(value).toLocaleString(locale.value, { style: 'currency', currency: 'EUR' });
  }
  return formatTokens(value);
}

// Bucket keys are UTC ISO fragments (2026-08-16, 2026-08, 2026); the axis
// shows them as dates in the selected language, read in UTC as well so a
// bucket never shifts to the neighboring day.
export function formatBucketLabel(key, granularity) {
  const opts = { timeZone: 'UTC' };
  if (granularity === 'year') return key;
  if (granularity === 'month') {
    const date = new Date(`${key}-01T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return key;
    return date.toLocaleDateString(locale.value, { ...opts, month: 'short', year: 'numeric' });
  }
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  const day = date.toLocaleDateString(locale.value, { ...opts, day: 'numeric', month: 'short' });
  return granularity === 'week' ? translate('chart.weekOf', { date: day }) : day;
}
