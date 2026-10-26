import { test, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useBudgetAlerts } from './useBudgetAlerts.js';
import { setBudget } from './budget.js';
import { formatChartValue } from './chartFormat.js';
import { translate } from './i18n.js';
import { USD_TO_EUR } from './pricing.js';

function memoryStorage() {
  const d = {};
  return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = String(v); } };
}
function fakeNotifier() {
  const instances = [];
  class N { constructor(title, opts) { instances.push({ title, opts }); } }
  N.instances = instances;
  return N;
}

// 1_000_000 input tokens on sonnet = 3 USD = 3 * USD_TO_EUR euros
const MILLION = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const euro = (millions) => 3 * millions * USD_TO_EUR;
function usageOf(millions) {
  const u = { ...MILLION, inputTokens: MILLION.inputTokens * millions };
  return { ...u, byModel: { 'claude-sonnet-5': u } };
}
function board(millions, extra = {}) {
  return { a: { sessions: { s1: { title: 'fix login', usage: usageOf(millions), ...extra } } } };
}

function setup({ repos, permission = 'granted', sound = false, dayCost = null, dayReady = false, now = Date.now() } = {}) {
  const notifier = fakeNotifier();
  const playSound = vi.fn();
  const refs = {
    repos: ref(repos ?? {}),
    dayCost: ref(dayCost),
    dayReady: ref(dayReady),
    now: ref(now),
    permission: ref(permission),
    soundOn: ref(sound),
  };
  useBudgetAlerts({ ...refs, notifier, playSound });
  return { ...refs, notifier, playSound };
}

beforeEach(() => { setBudget({ session: null, day: null }, memoryStorage()); });

test('nothing fires while the session threshold is off', async () => {
  const s = setup({ repos: board(1) });
  s.repos.value = board(10);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('a session already over the threshold at first sight records its level without notifying', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(8) }); // 4x the threshold, already there on load
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('crossing the threshold notifies once, with the session name, cost and threshold', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(0.5) });
  s.repos.value = board(1);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
  expect(s.notifier.instances[0].title).toBe(translate('budget.sessionAlert', {
    name: 'a', title: 'fix login', cost: formatChartValue(euro(1), 'cost'), threshold: formatChartValue(euro(1), 'cost'),
  }));
  s.repos.value = board(1.5); // same level
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
});

test('each doubling notifies again, and a jump over several levels notifies once', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(0.5) });
  s.repos.value = board(1);
  await nextTick();
  s.repos.value = board(2);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(2);
  s.repos.value = board(16);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(3);
});

test('permission denied: no notification, but sound plays when on', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(0.5), permission: 'denied', sound: true });
  s.repos.value = board(1);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
  expect(s.playSound).toHaveBeenCalledTimes(1);
});

test('sound off: playSound is not called', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(0.5), sound: false });
  s.repos.value = board(1);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
  expect(s.playSound).not.toHaveBeenCalled();
});

test('a session that disappears and comes back is treated as first sight', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(0.5) });
  s.repos.value = {};
  await nextTick();
  s.repos.value = board(4);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('changing the threshold re-baselines silently', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: board(2) });
  setBudget({ session: euro(0.1) }, memoryStorage());
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('a session with no usage never alerts', async () => {
  setBudget({ session: euro(1) }, memoryStorage());
  const s = setup({ repos: { a: { sessions: { s1: { usage: null } } } } });
  s.repos.value = { a: { sessions: { s1: { usage: null, title: 't' } } } };
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('day: nothing fires, and nothing is recorded, until the history is loaded', async () => {
  setBudget({ day: euro(1) }, memoryStorage());
  const s = setup({ dayCost: 0, dayReady: false });
  s.dayCost.value = euro(8);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
  s.dayReady.value = true; // first ready evaluation is silent, even at 8x
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
});

test('day: a later rise notifies once with the day text', async () => {
  setBudget({ day: euro(1) }, memoryStorage());
  const s = setup({ dayCost: euro(0.5), dayReady: true });
  s.dayCost.value = euro(1);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
  expect(s.notifier.instances[0].title).toBe(translate('budget.dayAlert', {
    cost: formatChartValue(euro(1), 'cost'), threshold: formatChartValue(euro(1), 'cost'),
  }));
  s.dayCost.value = euro(1.2);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
});

test('day: a new local day resets the level silently', async () => {
  setBudget({ day: euro(1) }, memoryStorage());
  const s = setup({ dayCost: euro(4), dayReady: true, now: new Date(2026, 9, 26, 23, 59).getTime() });
  s.now.value = new Date(2026, 9, 27, 0, 1).getTime();
  s.dayCost.value = euro(0.2);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(0);
  s.dayCost.value = euro(1);
  await nextTick();
  expect(s.notifier.instances).toHaveLength(1);
});
