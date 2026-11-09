import { costByModel } from './pricing.js';

function emptyTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function addTokenUsage(target, usage) {
  target.inputTokens += usage?.inputTokens ?? 0;
  target.outputTokens += usage?.outputTokens ?? 0;
  target.cacheCreationInputTokens += usage?.cacheCreationInputTokens ?? 0;
  target.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
}

function addCostByModel(target, usage) {
  for (const [model, cost] of Object.entries(costByModel(usage))) {
    target[model] = (target[model] ?? 0) + cost;
  }
}

export function tokenTotal(tokens) {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationInputTokens + tokens.cacheReadInputTokens;
}

// UTC-based (not the browser's local time) so bucketing is deterministic
// regardless of where this runs.
export function bucketKey(iso, granularity) {
  const d = new Date(iso);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (granularity === 'year') return String(year);
  if (granularity === 'month') return `${year}-${String(month + 1).padStart(2, '0')}`;
  if (granularity === 'day') return d.toISOString().slice(0, 10);
  // week: Monday-start, keyed by that Monday's date
  const monday = new Date(Date.UTC(year, month, d.getUTCDate()));
  const dow = (monday.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  monday.setUTCDate(monday.getUTCDate() - dow);
  return monday.toISOString().slice(0, 10);
}

// entries: a Vue ref/computed wrapping the array useHistory() already fetched.
export function useHistoryStats(entries) {
  function bucketByPeriod(granularity) {
    const buckets = new Map();
    for (const entry of entries.value) {
      if (!entry.endedAt) continue;
      const key = bucketKey(entry.endedAt, granularity);
      if (!buckets.has(key)) buckets.set(key, { key, tokens: emptyTokenUsage(), costByModel: {} });
      const bucket = buckets.get(key);
      addTokenUsage(bucket.tokens, entry.usage);
      addCostByModel(bucket.costByModel, entry.usage);
    }
    // Keys are unique (they are the Map's keys), so two buckets never compare equal.
    return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  function totalsByProject() {
    const totals = new Map();
    for (const entry of entries.value) {
      if (!totals.has(entry.repo)) totals.set(entry.repo, { repo: entry.repo, tokens: emptyTokenUsage(), costByModel: {} });
      const t = totals.get(entry.repo);
      addTokenUsage(t.tokens, entry.usage);
      addCostByModel(t.costByModel, entry.usage);
    }
    return [...totals.values()].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
  }

  return { bucketByPeriod, totalsByProject };
}
