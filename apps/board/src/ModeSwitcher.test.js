import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModeSwitcher from './ModeSwitcher.vue';
import { DEFAULT_THEME, DEFAULT_MODE, theme, mode, setTheme } from './theme.js';
import { DEFAULT_LOCALE, locale } from './i18n.js';

afterEach(() => {
  theme.value = DEFAULT_THEME;
  mode.value = DEFAULT_MODE;
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
  // setTheme()/setMode() stamp the real document — resetting the refs above
  // doesn't undo that, so a picked value would otherwise leak into whatever
  // mounts next, the way LocaleSwitcher.test.js resets
  // document.documentElement.lang.
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
});

test('lists the three modes with the active one selected', () => {
  const w = mount(ModeSwitcher);
  const select = w.get('[data-test=mode]');
  expect(select.findAll('option').map((o) => o.attributes('value')))
    .toEqual(['light', 'dark', 'system']);
  expect(select.element.value).toBe('system');
});

test('picking a mode stamps the document and persists the choice', async () => {
  const w = mount(ModeSwitcher);
  await w.get('[data-test=mode]').setValue('dark');
  expect(mode.value).toBe('dark');
  expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
  expect(window.localStorage.getItem('maggie:mode')).toBe('dark');
});

test('is disabled on a light-only theme and explains why', async () => {
  setTheme('legacy', { storage: window.localStorage, doc: document });
  const w = mount(ModeSwitcher);
  const select = w.get('[data-test=mode]');
  expect(select.attributes('disabled')).toBeDefined();
  expect(select.attributes('title')).toBe('This theme is light only.');
});

test('leaves the stored preference alone while disabled', async () => {
  const storage = window.localStorage;
  setTheme('m3', { storage, doc: document });
  mount(ModeSwitcher);
  const w = mount(ModeSwitcher);
  await w.get('[data-test=mode]').setValue('dark');
  setTheme('legacy', { storage, doc: document });
  expect(storage.getItem('maggie:mode')).toBe('dark');
  expect(mode.value).toBe('dark');
});
