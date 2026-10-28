import { formatChartValue } from './chartFormat.js';
import { translate } from './i18n.js';

// A described usage (see liveUsage.js) as the board writes it: a "~" in front
// of the amount when any of it is priced at a guess.
export function costText(described) {
  return `${described.estimate ? '~' : ''}${formatChartValue(described.cost, 'cost')}`;
}

// The tooltip behind a cost figure: where the money went, what is guessed, and
// how the prompt cache is doing.
export function costTitle(described) {
  const parts = [
    translate('session.costTooltip', {
      breakdown: described.byModel.map((m) => `${m.model} ${formatChartValue(m.cost, 'cost')}`).join(' · '),
    }),
  ];
  if (described.estimate) parts.push(translate('session.estimateHint'));
  if (described.cacheRate !== null) parts.push(translate('session.cacheRate', { rate: Math.round(described.cacheRate * 100) }));
  if (described.lowCache) parts.push(translate('session.cacheLow'));
  return parts.join('\n');
}
