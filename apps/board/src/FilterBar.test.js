import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FilterBar from './FilterBar.vue';

test('emits name updates as the user types', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', technologies: ['nestjs', 'postgres'] } });
  await w.get('[data-test=search]').setValue('oc-be');
  expect(w.emitted('update:name')[0]).toEqual(['oc-be']);
});

test('lists technologies and emits tech selection', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', technologies: ['nestjs', 'postgres'] } });
  const options = w.findAll('option').map((o) => o.text());
  expect(options).toContain('nestjs');
  expect(options).toContain('postgres');
  await w.get('[data-test=tech]').setValue('nestjs');
  expect(w.emitted('update:tech')[0]).toEqual(['nestjs']);
});

test('offers the three CI filters and emits the selection', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', ci: '', technologies: [] } });
  const options = w.get('[data-test=ci]').findAll('option').map((o) => o.text());
  expect(options).toEqual(['CI: all', 'failing', 'OK', 'unknown']);
  await w.get('[data-test=ci]').setValue('failure');
  expect(w.emitted('update:ci')[0]).toEqual(['failure']);
});

test('offers the skills sync filters and emits the selection', async () => {
  const w = mount(FilterBar, { props: { name: '', tech: '', ci: '', sync: '', technologies: [] } });
  const options = w.get('[data-test=sync]').findAll('option').map((o) => o.attributes('value'));
  expect(options).toEqual(['', 'drift', 'in-sync', 'error', 'unknown']);
  await w.get('[data-test=sync]').setValue('drift');
  expect(w.emitted('update:sync')[0]).toEqual(['drift']);
});
