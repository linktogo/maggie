import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RetroDocLog from './RetroDocLog.vue';

test('prints one timestamped line per entry, in order', () => {
  const w = mount(RetroDocLog, {
    props: {
      log: [
        { at: '2026-09-14T09:57:30.000Z', text: 'starting on /home/me/wk/api through claude CLI' },
        { at: '2026-09-14T09:59:12.000Z', text: '  ↳ digest 1/5 answered in 1m 42s — 4821 chars' },
      ],
    },
  });
  const text = w.get('[data-test=retro-log]').text();
  expect(text).toMatch(/\d{2}:\d{2}:\d{2}\s+starting on \/home\/me\/wk\/api/);
  expect(text.indexOf('starting on')).toBeLessThan(text.indexOf('answered in'));
});

test('renders a line whose timestamp is unusable rather than printing "Invalid Date"', () => {
  const w = mount(RetroDocLog, { props: { log: [{ at: 'not a date', text: 'still worth showing' }] } });
  expect(w.get('[data-test=retro-log]').text()).toContain('--:--:--');
  expect(w.get('[data-test=retro-log]').text()).toContain('still worth showing');
});

test('follows the tail when a line is appended', async () => {
  const log = [{ at: '2026-09-14T09:57:30.000Z', text: 'first' }];
  const w = mount(RetroDocLog, { props: { log } });
  const box = w.get('[data-test=retro-log]').element;
  Object.defineProperty(box, 'scrollHeight', { value: 500, configurable: true });
  await w.setProps({ log: [...log, { at: '2026-09-14T09:58:00.000Z', text: 'second' }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(box.scrollTop).toBe(500);
});
