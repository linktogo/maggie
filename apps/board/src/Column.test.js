import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Column from './Column.vue';
import Card from './Card.vue';

function mountColumn(status) {
  return mount(Column, { props: { title: 'Done', status, entries: [], now: 0 } });
}

test('drop on the done column emits close-session with the dropped payload', async () => {
  const w = mountColumn('done');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'oc-be', sessionId: 's1' }) };
  await w.get('[data-test=column-body]').trigger('drop', { dataTransfer });
  expect(w.emitted('close-session')[0]).toEqual([{ repo: 'oc-be', sessionId: 's1' }]);
});

test('dragover on the done column highlights the drop zone, dragleave clears it', async () => {
  const w = mountColumn('done');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).toContain('ring-2');
  await body.trigger('dragleave');
  expect(body.classes()).not.toContain('ring-2');
});

test('dropping clears the drop-zone highlight', async () => {
  const w = mountColumn('done');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).toContain('ring-2');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'a', sessionId: 's1' }) };
  await body.trigger('drop', { dataTransfer });
  expect(body.classes()).not.toContain('ring-2');
});

test('a non-done column has no drag listeners: dragover does not highlight, drop emits nothing', async () => {
  const w = mountColumn('todo');
  const body = w.get('[data-test=column-body]');
  await body.trigger('dragover');
  expect(body.classes()).not.toContain('ring-2');
  const dataTransfer = { getData: () => JSON.stringify({ repo: 'a', sessionId: 's1' }) };
  await body.trigger('drop', { dataTransfer });
  expect(w.emitted('close-session')).toBeUndefined();
});

const session = { sessionId: 's1', status: 'todo', lastEvent: 'init', updatedAt: '2026-06-21T09:59:00.000Z' };
const now = Date.parse('2026-06-21T10:00:00.000Z');

test('passes each entry its own CI status', () => {
  const w = mount(Column, {
    props: {
      title: 'To do', status: 'todo', entries: [{ name: 'oc-be', sessions: [session] }], now,
      ci: { 'oc-be': { users: { alice: { state: 'failure' } } } },
    },
  });
  expect(w.get('[data-test=ci-badge]').text()).toBe('AL');
});

test('renders cards unharmed when no CI map is given', () => {
  const w = mount(Column, { props: { title: 'To do', status: 'todo', entries: [{ name: 'oc-be', sessions: [session] }], now } });
  expect(w.text()).toContain('oc-be');
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(0);
});

test('forwards send-message emitted by a card up to the parent', async () => {
  const w = mount(Column, {
    props: { title: 'Question', status: 'question', entries: [{ name: 'oc-be', sessions: [{ sessionId: 's1', status: 'question', lastEvent: 'Stop', updatedAt: 'T', title: 't', lastPrompt: 'p', events: [] }] }], now: 0 },
  });
  await w.findComponent(Card).vm.$emit('send-message', { repo: 'oc-be', sessionId: 's1', text: 'go' });
  expect(w.emitted('send-message')[0]).toEqual([{ repo: 'oc-be', sessionId: 's1', text: 'go' }]);
});

test('an empty column says so, and the done column says what dropping there does', () => {
  const todo = mount(Column, { props: { title: 'To do', status: 'todo', entries: [] } });
  expect(todo.get('[data-test=column-empty]').text()).toBe('Nothing here');
  const done = mount(Column, { props: { title: 'Done', status: 'done', entries: [] } });
  expect(done.get('[data-test=column-empty]').text()).toBe('Drag a session here to close it');
});

test('a column with cards shows no empty hint', () => {
  const w = mount(Column, { props: { title: 'To do', status: 'todo', entries: [{ name: 'oc-be', sessions: [] }] } });
  expect(w.find('[data-test=column-empty]').exists()).toBe(false);
});
