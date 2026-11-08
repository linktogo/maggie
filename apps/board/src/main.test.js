import { test, expect, vi } from 'vitest';

const app = { use: vi.fn(() => app), mount: vi.fn() };
const router = { name: 'router' };
const calls = [];

vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), createApp: vi.fn(() => app) }));
vi.mock('./App.vue', () => ({ default: { name: 'App' } }));
vi.mock('./router.js', () => ({ createBoardRouter: vi.fn(() => router) }));
vi.mock('./i18n.js', () => ({ initLocale: vi.fn(() => calls.push('locale')) }));
vi.mock('./theme.js', () => ({ initTheme: vi.fn(() => calls.push('theme')) }));
vi.mock('./style.css', () => ({}));

test('main.js restores the locale and theme, then mounts the routed App on #app', async () => {
  const { createApp } = await import('vue');
  await import('./main.js');
  expect(calls).toEqual(['locale', 'theme']);
  expect(createApp).toHaveBeenCalledWith({ name: 'App' });
  expect(app.use).toHaveBeenCalledWith(router);
  expect(app.mount).toHaveBeenCalledWith('#app');
});
