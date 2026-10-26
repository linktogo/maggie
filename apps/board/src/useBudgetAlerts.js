import { watch } from 'vue';
import { alertLevel, budget } from './budget.js';
import { formatChartValue } from './chartFormat.js';
import { translate } from './i18n.js';
import { costOf } from './pricing.js';
import { defaultPlaySound } from './useNotifications.js';

const euro = (n) => formatChartValue(n, 'cost');

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Notifies when a session, or the day, crosses its budget: at the threshold and
// at each doubling. Anything already over when first seen is recorded silently,
// so reloading the page never replays alerts.
export function useBudgetAlerts({
  repos, dayCost, dayReady, now, permission, soundOn,
  notifier = globalThis.Notification,
  playSound = defaultPlaySound,
}) {
  const sessionLevels = new Map();
  let sessionThreshold = null;
  let dayLevel = 0;
  let dayKey = null;
  let dayThreshold = null;

  function emit(messages) {
    if (messages.length === 0) return;
    if (notifier && permission.value === 'granted') {
      for (const text of messages) new notifier(text);
    }
    if (soundOn.value) playSound();
  }

  function checkSessions() {
    const threshold = budget.value.session;
    if (threshold !== sessionThreshold) {
      sessionLevels.clear();
      sessionThreshold = threshold;
    }
    if (threshold === null) return;
    const seen = new Set();
    const messages = [];
    for (const [name, repoEntry] of Object.entries(repos.value)) {
      for (const [sessionId, session] of Object.entries(repoEntry.sessions ?? {})) {
        const key = `${name}/${sessionId}`;
        seen.add(key);
        const cost = costOf(session.usage);
        const level = alertLevel(cost, threshold);
        const previous = sessionLevels.get(key);
        sessionLevels.set(key, level);
        if (previous !== undefined && level > previous) {
          messages.push(translate('budget.sessionAlert', {
            name, title: session.title ?? sessionId, cost: euro(cost), threshold: euro(threshold),
          }));
        }
      }
    }
    for (const key of sessionLevels.keys()) if (!seen.has(key)) sessionLevels.delete(key);
    emit(messages);
  }

  function checkDay() {
    const threshold = budget.value.day;
    if (threshold === null || !dayReady.value) {
      dayKey = null;
      dayThreshold = null;
      return;
    }
    const key = localDayKey(now.value);
    const level = alertLevel(dayCost.value, threshold);
    if (key !== dayKey || threshold !== dayThreshold) {
      dayKey = key;
      dayThreshold = threshold;
      dayLevel = level;
      return;
    }
    const rose = level > dayLevel;
    dayLevel = level;
    if (rose) emit([translate('budget.dayAlert', { cost: euro(dayCost.value), threshold: euro(threshold) })]);
  }

  watch([repos, () => budget.value], checkSessions, { deep: true, immediate: true });
  watch([dayCost, dayReady, now, () => budget.value], checkDay, { immediate: true });
}
