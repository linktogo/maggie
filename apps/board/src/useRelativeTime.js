import { ref, onUnmounted } from 'vue';
import { translate } from './i18n.js';

// Reads the active locale through translate(), so a component rendering a
// relative time re-renders in the new language as soon as it is switched.
export function relativeTime(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return translate('time.secondsAgo', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return translate('time.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return translate('time.hoursAgo', { n: h });
  return translate('time.daysAgo', { n: Math.floor(h / 24) });
}

// Reactive "now" that updates on an interval, for live-refreshing relative times.
export function useNow(intervalMs = 1000) {
  const now = ref(Date.now());
  const timer = setInterval(() => { now.value = Date.now(); }, intervalMs);
  onUnmounted(() => clearInterval(timer));
  return now;
}
