import { describe, test, expect, vi, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useNotifications, defaultPlaySound } from './useNotifications.js';
import { DEFAULT_LOCALE, locale, setLocale } from './i18n.js';

afterEach(() => { locale.value = DEFAULT_LOCALE; });

function fakeNotifier(permission = 'granted') {
  const instances = [];
  class N { constructor(title, opts) { instances.push({ title, opts }); } }
  N.permission = permission;
  N.requestPermission = vi.fn().mockResolvedValue('granted');
  N.instances = instances;
  return N;
}
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('fires a notification for each transition when permission granted', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('granted');
  const playSound = vi.fn();
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' }, playSound });
  transitions.value = [{ name: 'oc-auth', status: 'question' }];
  await nextTick();
  expect(notifier.instances.length).toBe(1);
  expect(notifier.instances[0].title).toContain('oc-auth');
  expect(playSound).not.toHaveBeenCalled(); // sound off by default
});

test('requestPermission delegates to the Notification API', async () => {
  const notifier = fakeNotifier('default');
  const { requestPermission, permission } = useNotifications(ref([]), ref(0), { notifier, storage: fakeStorage(), doc: { title: '' } });
  await requestPermission();
  expect(notifier.requestPermission).toHaveBeenCalled();
  expect(permission.value).toBe('granted');
});

test('sound toggle persists and gates playSound', async () => {
  const transitions = ref([]);
  const storage = fakeStorage();
  const playSound = vi.fn();
  const { toggleSound, soundOn } = useNotifications(transitions, ref(0), { notifier: fakeNotifier('granted'), storage, doc: { title: '' }, playSound });
  toggleSound();
  expect(soundOn.value).toBe(true);
  expect(storage.getItem('maggie:sound')).toBe('1');
  transitions.value = [{ name: 'a', status: 'done' }];
  await nextTick();
  expect(playSound).toHaveBeenCalled();
});

test('updates the document title badge from the question count', async () => {
  const doc = { title: '' };
  const count = ref(0);
  useNotifications(ref([]), count, { notifier: fakeNotifier('granted'), storage: fakeStorage(), doc });
  await nextTick();
  expect(doc.title).toBe('maggie board');
  count.value = 2;
  await nextTick();
  expect(doc.title).toBe('(2) maggie board');
});

test('includes the session title in the notification when present', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('granted');
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' } });
  transitions.value = [{ name: 'oc-auth', sessionId: 's1', title: 'fix login redirect', status: 'question' }];
  await nextTick();
  expect(notifier.instances[0].title).toBe('oc-auth · fix login redirect → Question');
});

test('notification bodies are written in the selected language', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('granted');
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' } });

  transitions.value = [{ name: 'oc-auth', status: 'question' }];
  await nextTick();
  expect(notifier.instances[0].opts.body).toBe('An agent is waiting for your input');

  setLocale('es', { storage: null, doc: null });
  transitions.value = [{ name: 'oc-auth', status: 'done' }];
  await nextTick();
  expect(notifier.instances[1].opts.body).toBe('Trabajo terminado');
});

describe('defaultPlaySound', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function fakeAudioContext() {
    const osc = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    class Ctx { constructor() { this.destination = 'dest'; this.currentTime = 1; } createOscillator() { return osc; } }
    return { Ctx, osc };
  }

  test('plays a short 880 Hz beep through AudioContext', () => {
    const { Ctx, osc } = fakeAudioContext();
    vi.stubGlobal('AudioContext', Ctx);
    defaultPlaySound();
    expect(osc.frequency.value).toBe(880);
    expect(osc.connect).toHaveBeenCalledWith('dest');
    expect(osc.start).toHaveBeenCalled();
    expect(osc.stop).toHaveBeenCalledWith(1.12);
  });

  test('falls back to webkitAudioContext', () => {
    const { Ctx, osc } = fakeAudioContext();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', Ctx);
    defaultPlaySound();
    expect(osc.start).toHaveBeenCalled();
  });

  test('does nothing without any audio API, and swallows audio errors', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(() => defaultPlaySound()).not.toThrow();
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked'); } });
    expect(() => defaultPlaySound()).not.toThrow();
  });
});

test('without a Notification API: permission is unsupported, requesting is a no-op, sound still plays', async () => {
  const transitions = ref([]);
  const playSound = vi.fn();
  const n = useNotifications(transitions, ref(0), { notifier: null, storage: fakeStorage({ 'maggie:sound': '1' }), doc: null, playSound });
  expect(n.permission.value).toBe('unsupported');
  await n.requestPermission();
  expect(n.permission.value).toBe('unsupported');
  transitions.value = [{ name: 'a', status: 'done' }];
  await nextTick();
  expect(playSound).toHaveBeenCalledTimes(1);
});

test('permission not granted: no notification is shown', async () => {
  const transitions = ref([]);
  const notifier = fakeNotifier('default');
  useNotifications(transitions, ref(0), { notifier, storage: fakeStorage(), doc: { title: '' }, playSound: vi.fn() });
  transitions.value = [{ name: 'a', status: 'done' }];
  await nextTick();
  expect(notifier.instances).toHaveLength(0);
});

test('toggling the sound off again persists "0"', () => {
  const storage = fakeStorage();
  const n = useNotifications(ref([]), ref(0), { notifier: fakeNotifier(), storage, doc: null, playSound: vi.fn() });
  n.toggleSound();
  n.toggleSound();
  expect(n.soundOn.value).toBe(false);
  expect(storage.getItem('maggie:sound')).toBe('0');
});
