// Prompt-cache health: the share of input-side tokens served from cache.
export const LOW_CACHE_RATE = 0.5;
// Below this many input-side tokens a session has had nothing to cache yet, so
// a low rate says nothing.
export const LOW_CACHE_MIN_TOKENS = 50_000;

export function inputSideTokens(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.cacheCreationInputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
}

export function cacheHitRate(usage) {
  const total = inputSideTokens(usage);
  return total === 0 ? null : (usage.cacheReadInputTokens ?? 0) / total;
}
