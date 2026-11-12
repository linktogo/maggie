import { test, expect, vi } from 'vitest';
import { nextTick } from 'vue';
import { useConfig } from './useConfig.js';

test('fetches /api/config once and exposes repos', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ repos: { a: { url: 'u', technologies: ['nestjs'], targets: [] } } }) });
  const { repos } = useConfig({ fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(fetchImpl).toHaveBeenCalledWith('/api/config');
  expect(repos.value.a.url).toBe('u');
});

test('degrades to empty repos on fetch error', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
  const { repos } = useConfig({ fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(repos.value).toEqual({});
});

test('treats a payload without repos as empty', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({}) });
  const { repos } = useConfig({ fetchImpl });
  await nextTick(); await Promise.resolve();
  expect(repos.value).toEqual({});
});
