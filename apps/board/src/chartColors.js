// Chart.js paints on a canvas, which cannot read CSS custom properties, so the
// theme tokens are resolved to plain strings at render time. The charts re-run
// this on every theme or mode change.
//
// The fallbacks are the colors the charts used before themes existed. They
// cover jsdom, where getComputedStyle returns an empty string for a custom
// property, and any moment the canvas is not in the document yet.
export const FALLBACK = {
  '--color-series-1': '#2563eb',
  '--color-series-2': '#10b981',
  '--color-series-3': '#f59e0b',
  '--color-series-4': '#94a3b8',
  '--color-series-5': '#8b5cf6',
  '--color-series-6': '#ec4899',
  '--color-ink-muted': '#64748b',
};

export function tokenColor(name, {
  el = globalThis.document?.documentElement,
  computed = globalThis.getComputedStyle,
} = {}) {
  try {
    const value = computed?.(el)?.getPropertyValue(name)?.trim();
    if (value) return value;
  } catch { /* no computed styles available — fall through to the fallback */ }
  return FALLBACK[name];
}

export function seriesColors(options = {}) {
  return [1, 2, 3, 4, 5, 6].map((i) => tokenColor(`--color-series-${i}`, options));
}

export function chartInk(options = {}) {
  return tokenColor('--color-ink-muted', options);
}
