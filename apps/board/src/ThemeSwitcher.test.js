import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ThemeSwitcher from './ThemeSwitcher.vue';
import { DEFAULT_THEME, DEFAULT_MODE, theme, mode } from './theme.js';
import { DEFAULT_LOCALE, locale, setLocale } from './i18n.js';

afterEach(() => {
  theme.value = DEFAULT_THEME;
  mode.value = DEFAULT_MODE;
  locale.value = DEFAULT_LOCALE;
  window.localStorage.clear();
});

test('lists the four themes with the active one selected', () => {
  const w = mount(ThemeSwitcher);
  const select = w.get('[data-test=theme]');
  expect(select.findAll('option').map((o) => o.attributes('value')))
    .toEqual(['m3', 'expressive', 'classic', 'legacy']);
  expect(select.element.value).toBe('m3');
});

test('translates the theme names', () => {
  const w = mount(ThemeSwitcher);
  expect(w.text()).toContain('Material 3 Expressive');
  expect(w.text()).toContain('Legacy (frozen)');

  setLocale('fr', { storage: window.localStorage, doc: null });
  const fr = mount(ThemeSwitcher);
  expect(fr.text()).toContain('Material classique');
  expect(fr.text()).toContain('Historique (figé)');
});

test('picking a theme stamps the document and persists the choice', async () => {
  const w = mount(ThemeSwitcher);
  await w.get('[data-test=theme]').setValue('classic');
  expect(theme.value).toBe('classic');
  expect(document.documentElement.getAttribute('data-theme')).toBe('classic');
  expect(window.localStorage.getItem('maggie:theme')).toBe('classic');
});

test('labels itself for assistive technology', () => {
  const w = mount(ThemeSwitcher);
  expect(w.get('[data-test=theme]').attributes('aria-label')).toBe('Theme');
});
