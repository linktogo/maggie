import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import LocaleSwitcher from './LocaleSwitcher.vue';
import { DEFAULT_LOCALE, locale, STORAGE_KEY } from './i18n.js';

afterEach(() => {
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
  document.documentElement.lang = 'en';
});

test('lists the four languages and starts on English', () => {
  const w = mount(LocaleSwitcher);
  const select = w.get('[data-test=locale]');
  expect(select.findAll('option').map((o) => o.text())).toEqual(['English', 'Français', 'Deutsch', 'Español']);
  expect(select.element.value).toBe('en');
});

test('selecting a language switches, persists and tags the document', async () => {
  const w = mount(LocaleSwitcher);
  await w.get('[data-test=locale]').setValue('fr');
  expect(locale.value).toBe('fr');
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe('fr');
  expect(document.documentElement.lang).toBe('fr');
});

test('is labelled for screen readers in the active language', async () => {
  const w = mount(LocaleSwitcher);
  expect(w.get('[data-test=locale]').attributes('aria-label')).toBe('Language');
  await w.get('[data-test=locale]').setValue('de');
  expect(w.get('[data-test=locale]').attributes('aria-label')).toBe('Sprache');
});
