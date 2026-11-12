import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Icon from './Icon.vue';
import { ICONS } from './icons.js';
import { DEFAULT_THEME, theme } from './theme.js';

afterEach(() => { theme.value = DEFAULT_THEME; });

test('renders the requested glyph', () => {
  const w = mount(Icon, { props: { name: 'notifications' } });
  expect(w.get('svg path').attributes('d')).toBe(ICONS.notifications);
});

test('renders the legacy emoji twin alongside it, marked for the theme to pick', () => {
  const w = mount(Icon, { props: { name: 'notifications', emoji: '🔔' } });
  expect(w.get('.icon').classes()).toContain('has-emoji');
  expect(w.get('.icon-emoji').text()).toBe('🔔');
  expect(w.find('.icon-symbol').exists()).toBe(true);
});

test('carries no emoji twin when none is given', () => {
  const w = mount(Icon, { props: { name: 'search' } });
  expect(w.get('.icon').classes()).not.toContain('has-emoji');
  expect(w.find('.icon-emoji').exists()).toBe(false);
});

test('is hidden from assistive technology — the label lives in the neighboring text', () => {
  const w = mount(Icon, { props: { name: 'close', emoji: '✕' } });
  expect(w.get('.icon').attributes('aria-hidden')).toBe('true');
});
