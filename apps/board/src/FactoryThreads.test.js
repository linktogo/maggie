import { test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryThreads from './FactoryThreads.vue';
import { setLocale } from './i18n.js';

afterEach(() => setLocale('en'));

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const THREADS = [
  { id: 'th_1', repo: 'api', title: 'Fix the flaky test', status: 'running', updatedAt: ago(120000) },
  { id: 'th_2', repo: 'api', title: 'Add CI badge', status: 'idle', updatedAt: ago(3600000) },
  { id: 'th_3', repo: 'api', title: 'Broken', status: 'failed', updatedAt: ago(1000) },
];

test('shows status badges and relative times', () => {
  const w = mount(FactoryThreads, { props: { threads: THREADS, selected: 'th_1', archived: false } });
  expect(w.get('[data-test=factory-thread-th_1]').text()).toContain('Fix the flaky test');
  expect(w.get('[data-test=factory-thread-th_1]').text()).toContain('running');
  expect(w.get('[data-test=factory-thread-th_1]').text()).toContain('2 min ago');
  expect(w.get('[data-test=factory-thread-th_2]').text()).toContain('waiting');
  expect(w.get('[data-test=factory-thread-th_2]').text()).toContain('1h ago');
  expect(w.get('[data-test=factory-thread-th_3]').text()).toContain('failed');
});

test('shows the archived badge and a restore action when browsing archives', () => {
  const w = mount(FactoryThreads, { props: { threads: [{ ...THREADS[0], status: 'archived' }], selected: '', archived: true } });
  expect(w.get('[data-test=factory-thread-th_1]').text()).toContain('archived');
  expect(w.find('[data-test=factory-archive-th_1]').exists()).toBe(false);
});

test('emits new, select, archive and restore', async () => {
  const w = mount(FactoryThreads, { props: { threads: THREADS, selected: '', archived: false } });
  await w.get('[data-test=factory-new]').trigger('click');
  await w.get('[data-test=factory-thread-th_2]').trigger('click');
  await w.get('[data-test=factory-archive-th_2]').trigger('click');
  await w.get('[data-test=factory-archived-toggle]').setValue(true);
  expect(w.emitted('new')).toHaveLength(1);
  expect(w.emitted('select')).toEqual([['th_2']]);
  expect(w.emitted('archive')).toEqual([['th_2']]);
  expect(w.emitted('toggle-archived')).toHaveLength(1);

  await w.setProps({ archived: true, threads: [{ ...THREADS[1], status: 'archived' }] });
  await w.get('[data-test=factory-restore-th_2]').trigger('click');
  expect(w.emitted('restore')).toEqual([['th_2']]);
});
