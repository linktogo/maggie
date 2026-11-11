// USD per million tokens, as Anthropic publishes them. Maintained by hand — no
// network pricing lookup. Update this table (and USD_TO_EUR) when published
// prices change; cost is computed at render time from raw token counts, so a
// correction here retroactively re-prices the entire history. Amounts reach the
// UI in euros: costByModel applies USD_TO_EUR.
export const PRICING = {
  'claude-opus-5': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  default: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

// Indicative USD→EUR factor, set by hand — no network lookup. ECB reference rate
// of 1.1574 USD per EUR on 2025-06-16 (1 / 1.1574). STALE by design of being
// hand-set: refresh it whenever PRICING is reviewed.
export const USD_TO_EUR = 0.864;

const PER_MILLION = 1_000_000;
export const UNKNOWN_MODEL = 'unknown';

// Exact id, else the longest table key that is a prefix on a '-' boundary
// (claude-sonnet-5-5 → claude-sonnet-5), else null. 'default' is a fallback
// rate, never a model id.
export function rateFor(model) {
  let best = null;
  for (const key of Object.keys(PRICING)) {
    if (key === 'default') continue;
    if (model !== key && !model.startsWith(`${key}-`)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : PRICING[best];
}

// True when the figure for this usage involves a guessed rate: a model the table
// does not know, or no per-model breakdown at all.
export function isEstimate(usage) {
  if (!usage) return false;
  const models = Object.keys(usage.byModel ?? {});
  if (models.length === 0) return true;
  return models.some((model) => rateFor(model) === null);
}

function costForModel(usage, rate) {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) * rate.input
    + (usage.outputTokens ?? 0) * rate.output
    + (usage.cacheCreationInputTokens ?? 0) * rate.cacheWrite
    + (usage.cacheReadInputTokens ?? 0) * rate.cacheRead
  ) / PER_MILLION;
}

// Cost broken down per model, so a chart can render one segment per model.
// A session with no byModel breakdown (pre-migration history, or a transcript
// turn with no message.model) is priced as a whole at the default rate, under
// the 'unknown' key — never silently dropped or zeroed out.
export function costByModel(usage) {
  if (!usage) return {};
  const byModel = usage.byModel;
  if (byModel && Object.keys(byModel).length > 0) {
    const out = {};
    for (const [model, modelUsage] of Object.entries(byModel)) {
      out[model] = costForModel(modelUsage, rateFor(model) ?? PRICING.default) * USD_TO_EUR;
    }
    return out;
  }
  return { [UNKNOWN_MODEL]: costForModel(usage, PRICING.default) * USD_TO_EUR };
}

export function costOf(usage) {
  return Object.values(costByModel(usage)).reduce((sum, cost) => sum + cost, 0);
}
