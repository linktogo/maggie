import { ref } from 'vue';

export const BUDGET_KEY = 'maggie:budget';

const OFF = { session: null, day: null };

function valid(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function clean(raw) {
  return { session: valid(raw?.session) ? raw.session : null, day: valid(raw?.day) ? raw.day : null };
}

// Thresholds are euros, held in this browser only (same convention as the sound
// preference). Anything unreadable means "off" — the board never needs them.
export function readBudget(storage) {
  try {
    // resolved inside the try: reading the localStorage getter itself can throw
    const raw = (storage ?? globalThis.localStorage)?.getItem(BUDGET_KEY);
    return raw ? clean(JSON.parse(raw)) : { ...OFF };
  } catch {
    return { ...OFF };
  }
}

export const budget = ref(readBudget());

// A null field clears it; a field that is not a finite number above zero is
// ignored and the previous value kept.
export function setBudget(next, storage) {
  const merged = { ...budget.value };
  for (const key of ['session', 'day']) {
    if (!(key in next)) continue;
    if (next[key] === null) merged[key] = null;
    else if (valid(next[key])) merged[key] = next[key];
  }
  budget.value = merged;
  try {
    (storage ?? globalThis.localStorage)?.setItem(BUDGET_KEY, JSON.stringify(merged));
  } catch { /* storage unavailable — the value is still held for this page */ }
}

// 0 below the threshold, then 1 at the threshold, 2 at twice it, 3 at four
// times it… one alert per level.
export function alertLevel(cost, threshold) {
  if (!valid(threshold) || cost < threshold) return 0;
  return Math.floor(Math.log2(cost / threshold)) + 1;
}
