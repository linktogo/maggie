import { test, expect, afterEach } from 'vitest';
import {
  DEFAULT_THEME, DEFAULT_MODE, THEMES, MODES, THEME_STORAGE_KEY, MODE_STORAGE_KEY,
  isSupportedTheme, isSupportedMode, isLightOnly,
  theme, mode, setTheme, setMode, initTheme, useTheme,
} from './theme.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function throwingStorage() {
  return { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
}
function fakeDoc() {
  const attrs = {};
  return { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, attrs } };
}
// Stands in for window.matchMedia. `listeners` lets a test fire an OS change.
function fakeMedia(matches = false) {
  const listeners = [];
  const mql = {
    matches,
    addEventListener: (_event, fn) => listeners.push(fn),
    flip(next) { mql.matches = next; for (const fn of listeners) fn({ matches: next }); },
  };
  const media = () => mql;
  media.mql = mql;
  return media;
}
const noDoc = { storage: fakeStorage(), doc: null, media: fakeMedia() };

afterEach(() => { theme.value = DEFAULT_THEME; mode.value = DEFAULT_MODE; });

test('defaults to Material 3 tonal following the system mode', () => {
  expect(DEFAULT_THEME).toBe('m3');
  expect(DEFAULT_MODE).toBe('system');
  expect(theme.value).toBe('m3');
  expect(mode.value).toBe('system');
});

test('offers exactly four themes and three modes', () => {
  expect(THEMES.map((t) => t.code)).toEqual(['m3', 'expressive', 'classic', 'legacy']);
  expect(THEMES.map((t) => t.labelKey)).toEqual(['theme.m3', 'theme.expressive', 'theme.classic', 'theme.legacy']);
  expect(MODES.map((m) => m.code)).toEqual(['light', 'dark', 'system']);
  expect(isSupportedTheme('classic')).toBe(true);
  expect(isSupportedTheme('neon')).toBe(false);
  expect(isSupportedTheme(null)).toBe(false);
  expect(isSupportedMode('dark')).toBe(true);
  expect(isSupportedMode('sepia')).toBe(false);
});

test('legacy is the only light-only theme', () => {
  expect(isLightOnly('legacy')).toBe(true);
  expect(isLightOnly('m3')).toBe(false);
});

test('setTheme persists the choice and stamps the document', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  setTheme('expressive', { storage, doc, media: fakeMedia() });
  expect(theme.value).toBe('expressive');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe('expressive');
  expect(doc.documentElement.attrs['data-theme']).toBe('expressive');
});

test('setTheme ignores an unsupported theme', () => {
  const storage = fakeStorage();
  setTheme('neon', { storage, doc: null, media: fakeMedia() });
  expect(theme.value).toBe('m3');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe(null);
});

test('setMode persists the choice and stamps the resolved mode', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  setMode('dark', { storage, doc, media: fakeMedia() });
  expect(mode.value).toBe('dark');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('dark');
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('the document is never stamped "system": it resolves to light or dark', () => {
  const doc = fakeDoc();
  setMode('system', { storage: fakeStorage(), doc, media: fakeMedia(false) });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');

  setMode('system', { storage: fakeStorage(), doc, media: fakeMedia(true) });
  expect(mode.value).toBe('system');
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('an OS scheme change restamps a theme following the system', () => {
  const doc = fakeDoc();
  const media = fakeMedia(false);
  initTheme({ storage: fakeStorage(), doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
  media.mql.flip(true);
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('a light-only theme is stamped light while the stored mode is preserved', () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const media = fakeMedia();
  setMode('dark', { storage, doc, media });
  setTheme('legacy', { storage, doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
  expect(mode.value).toBe('dark');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('dark');

  setTheme('m3', { storage, doc, media });
  expect(doc.documentElement.attrs['data-mode']).toBe('dark');
});

test('initTheme restores a stored theme and mode', () => {
  const doc = fakeDoc();
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'classic', [MODE_STORAGE_KEY]: 'light' });
  initTheme({ storage, doc, media: fakeMedia() });
  expect(theme.value).toBe('classic');
  expect(mode.value).toBe('light');
  expect(doc.documentElement.attrs['data-theme']).toBe('classic');
});

test('initTheme falls back to the defaults and overwrites a bogus stored value', () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'neon', [MODE_STORAGE_KEY]: 'sepia' });
  initTheme({ storage, doc: null, media: fakeMedia() });
  expect(theme.value).toBe('m3');
  expect(mode.value).toBe('system');
  expect(storage.getItem(THEME_STORAGE_KEY)).toBe('m3');
  expect(storage.getItem(MODE_STORAGE_KEY)).toBe('system');
});

test('survives a storage that throws, and a runtime with no matchMedia', () => {
  initTheme({ storage: throwingStorage(), doc: null, media: undefined });
  expect(theme.value).toBe('m3');
  const doc = fakeDoc();
  setMode('system', { storage: throwingStorage(), doc, media: undefined });
  expect(doc.documentElement.attrs['data-mode']).toBe('light');
});

test('useTheme exposes the reactive state, the setters and the lists', () => {
  const api = useTheme();
  expect(api.theme.value).toBe('m3');
  expect(api.mode.value).toBe('system');
  expect(api.themes).toBe(THEMES);
  expect(api.modes).toBe(MODES);
  api.setTheme('classic', noDoc);
  expect(api.theme.value).toBe('classic');
  expect(api.isLightOnly('legacy')).toBe(true);
});
