import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FactoryComposer from './FactoryComposer.vue';

const THREAD = { id: 'th_1', provider: 'claude-cli', sessionId: 's1', status: 'idle' };

const sender = (result) => vi.fn(async () => result);

test('sends a trimmed prompt and clears it once the reply is accepted', async () => {
  const send = sender(true);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, error: null, send } });
  expect(w.get('[data-test=factory-send]').element.disabled).toBe(true);
  await w.get('[data-test=factory-reply]').setValue('  keep going  ');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(send).toHaveBeenCalledWith('keep going');
  expect(w.get('[data-test=factory-reply]').element.value).toBe('');
});

test('Enter sends the reply, Shift+Enter does not', async () => {
  const send = sender(true);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, error: null, send } });
  const reply = w.get('[data-test=factory-reply]');
  await reply.setValue('keep going');
  await reply.trigger('keydown', { key: 'Enter', shiftKey: true });
  expect(send).not.toHaveBeenCalled();
  await reply.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(send).toHaveBeenCalledWith('keep going');
  expect(reply.element.value).toBe('');
});

test('a refused reply (409) keeps the draft', async () => {
  const send = sender(false);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, error: null, send } });
  await w.get('[data-test=factory-reply]').setValue('keep going');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(send).toHaveBeenCalledTimes(1);
  expect(w.get('[data-test=factory-reply]').element.value).toBe('keep going');
});

test('a double click sends once, and Send is disabled while busy', async () => {
  let resolve;
  const send = vi.fn(() => new Promise((r) => { resolve = r; }));
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, error: null, send } });
  await w.get('[data-test=factory-reply]').setValue('keep going');
  await w.get('form').trigger('submit');
  await w.get('form').trigger('submit');
  expect(send).toHaveBeenCalledTimes(1);
  expect(w.get('[data-test=factory-send]').element.disabled).toBe(true);
  resolve(true);
  await flushPromises();
  expect(w.get('[data-test=factory-reply]').element.value).toBe('');
  await w.setProps({ busy: true });
  await w.get('[data-test=factory-reply]').setValue('more');
  expect(w.get('[data-test=factory-send]').element.disabled).toBe(true);
  await w.get('form').trigger('submit');
  expect(send).toHaveBeenCalledTimes(1);
});

test('is disabled with a reason for copilot threads and offers a restart', async () => {
  const w = mount(FactoryComposer, { props: { thread: { ...THREAD, provider: 'copilot', sessionId: null }, resumable: false, error: null } });
  expect(w.get('[data-test=factory-reply]').element.disabled).toBe(true);
  expect(w.get('[data-test=factory-cannot-resume]').text()).toContain('cannot be continued');
  await w.get('[data-test=factory-restart]').trigger('click');
  expect(w.emitted('restart')).toHaveLength(1);
});

test('offers a restart after a failed run even when resumable', () => {
  const w = mount(FactoryComposer, { props: { thread: { ...THREAD, status: 'idle' }, resumable: true, error: null, lastOutcome: 'failed' } });
  expect(w.find('[data-test=factory-restart]').exists()).toBe(true);
  expect(w.get('[data-test=factory-reply]').element.disabled).toBe(false);
});

test('shows Stop while running', async () => {
  const w = mount(FactoryComposer, { props: { thread: { ...THREAD, status: 'running' }, resumable: false, error: null } });
  expect(w.find('[data-test=factory-send]').exists()).toBe(false);
  expect(w.find('[data-test=factory-restart]').exists()).toBe(false);
  await w.get('[data-test=factory-stop]').trigger('click');
  expect(w.emitted('stop')).toHaveLength(1);
});

test('shows an error', () => {
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, error: 'a run is already active on api' } });
  expect(w.get('[data-test=factory-error]').text()).toContain('already active');
});

const CHOICES = [
  { label: 'In memory', text: '1. In memory' },
  { label: 'PostgreSQL with TypeORM', text: '2. PostgreSQL with TypeORM' },
];

test('quick replies show one chip per choice plus Other, and a click sends that choice', async () => {
  const send = sender(true);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, send, choices: CHOICES } });
  const chips = w.findAll('[data-test=factory-quick-reply]');
  expect(chips.map((c) => c.text())).toEqual(['1. In memory', '2. PostgreSQL with TypeORM']);
  expect(w.get('[data-test=factory-quick-other]').text()).toBe('Other…');
  expect(w.get('[data-test=factory-quick-replies]').attributes('aria-label')).toBe('Quick replies');
  await chips[1].trigger('click');
  await flushPromises();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('2. PostgreSQL with TypeORM');
});

test('a quick reply is sent once while it is pending, and the draft is left alone', async () => {
  let release;
  const send = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, send, choices: CHOICES } });
  await w.get('[data-test=factory-reply]').setValue('half-written');
  const chip = w.get('[data-test=factory-quick-reply]');
  await chip.trigger('click');
  await chip.trigger('click');
  expect(send).toHaveBeenCalledTimes(1);
  expect(chip.element.disabled).toBe(true);
  release(true);
  await flushPromises();
  expect(w.get('[data-test=factory-reply]').element.value).toBe('half-written');
});

test('a refused quick reply leaves the chips usable', async () => {
  const send = sender(false);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, send, choices: CHOICES } });
  await w.get('[data-test=factory-quick-reply]').trigger('click');
  await flushPromises();
  expect(w.get('[data-test=factory-quick-reply]').element.disabled).toBe(false);
});

test('Other focuses the reply box and sends nothing', async () => {
  const send = sender(true);
  const w = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, send, choices: CHOICES }, attachTo: document.body });
  await w.get('[data-test=factory-quick-other]').trigger('click');
  expect(document.activeElement).toBe(w.get('[data-test=factory-reply]').element);
  expect(send).not.toHaveBeenCalled();
  w.unmount();
});

test('no quick replies while the agent runs, when the thread cannot resume, or without choices', () => {
  const running = mount(FactoryComposer, { props: { thread: { ...THREAD, status: 'running' }, resumable: true, send: sender(true), choices: CHOICES } });
  expect(running.find('[data-test=factory-quick-replies]').exists()).toBe(false);
  const stuck = mount(FactoryComposer, { props: { thread: THREAD, resumable: false, send: sender(true), choices: CHOICES } });
  expect(stuck.find('[data-test=factory-quick-replies]').exists()).toBe(false);
  const none = mount(FactoryComposer, { props: { thread: THREAD, resumable: true, send: sender(true) } });
  expect(none.find('[data-test=factory-quick-replies]').exists()).toBe(false);
});
