import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryProjects from './FactoryProjects.vue';

const PROJECTS = [
  { repo: 'api', threads: 3, lastActivity: null, running: 1 },
  { repo: 'web', threads: 0, lastActivity: null, running: 0 },
];

test('lists projects with counts and a running dot', () => {
  const w = mount(FactoryProjects, { props: { projects: PROJECTS, selected: 'api' } });
  expect(w.get('[data-test=factory-project-api]').text()).toContain('3');
  expect(w.get('[data-test=factory-project-api]').text()).toContain('api');
  expect(w.find('[data-test=factory-project-api] [data-test=factory-running-dot]').exists()).toBe(true);
  expect(w.get('[data-test=factory-project-web]').text()).toContain('—');
  expect(w.find('[data-test=factory-project-web] [data-test=factory-running-dot]').exists()).toBe(false);
});

test('emits select and search', async () => {
  const w = mount(FactoryProjects, { props: { projects: PROJECTS, selected: '' } });
  await w.get('[data-test=factory-project-web]').trigger('click');
  expect(w.emitted('select')).toEqual([['web']]);
  await w.get('[data-test=factory-search]').setValue('flaky');
  expect(w.emitted('search')).toEqual([['flaky']]);
});
