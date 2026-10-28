import { cacheHitRate, inputSideTokens, LOW_CACHE_MIN_TOKENS, LOW_CACHE_RATE } from './cache.js';
import { costByModel, costOf, isEstimate } from './pricing.js';

// What the board shows about a session's usage: cost in euros, where it went,
// whether any of it is a guess, and how well the prompt cache is doing.
export function describeUsage(usage) {
  if (!usage) return null;
  const cacheRate = cacheHitRate(usage);
  return {
    cost: costOf(usage),
    estimate: isEstimate(usage),
    byModel: Object.entries(costByModel(usage))
      .map(([model, cost]) => ({ model, cost }))
      .sort((a, b) => b.cost - a.cost),
    cacheRate,
    lowCache: cacheRate !== null && cacheRate < LOW_CACHE_RATE && inputSideTokens(usage) >= LOW_CACHE_MIN_TOKENS,
  };
}
