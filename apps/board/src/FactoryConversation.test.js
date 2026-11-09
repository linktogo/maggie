import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryConversation from './FactoryConversation.vue';

const THREAD = { id: 'th_1', repo: 'api', provider: 'claude-cli', model: 'opus', title: 'Fix it', status: 'idle' };
let n = 0;
const msg = (role, kind, content, runId = 'r1') => ({ id: `m${n += 1}`, threadId: 'th_1', role, kind, content, runId, createdAt: '2026-11-07T10:00:00.000Z' });
const step = (tool) => msg('agent', 'step', { tool, summary: `${tool} x`, input: {} });

test('collapses the steps of a turn with a tool tally', () => {
  const messages = [
    msg('user', 'text', 'go'),
    step('Read'), step('Read'), step('Edit'), step('Read'), step('Edit'), step('Bash'),
    msg('agent', 'text', 'done'),
  ];
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages } });
  const groups = w.findAll('[data-test=factory-steps]');
  expect(groups).toHaveLength(1);
  expect(groups[0].get('summary').text()).toBe('6 steps (Read ×3, Edit ×2, Bash)');
  expect(groups[0].findAll('li')).toHaveLength(6);
});

test('uses the singular for a single step and splits groups by run', () => {
  const messages = [step('Read'), msg('agent', 'text', 'mid'), step('Edit'), step('Edit')];
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages } });
  const groups = w.findAll('[data-test=factory-steps] summary');
  expect(groups.map((g) => g.text())).toEqual(['1 step (Read)', '2 steps (Edit ×2)']);
});

test('renders agent markdown and user text as plain text', () => {
  const messages = [msg('user', 'text', '<b>mine</b>'), msg('agent', 'text', '**bold** <script>x</script>')];
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages } });
  expect(w.get('[data-test=factory-user]').text()).toBe('<b>mine</b>');
  expect(w.find('[data-test=factory-user] b').exists()).toBe(false);
  expect(w.get('[data-test=factory-agent] strong').text()).toBe('bold');
  expect(w.find('script').exists()).toBe(false);
});

test('shows errors in the warning colour', () => {
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages: [msg('system', 'error', 'boom')] } });
  expect(w.get('[data-test=factory-error-message]').classes()).toContain('text-question-on-soft');
  expect(w.get('[data-test=factory-error-message]').text()).toContain('boom');
});

test('shows the outcome divider with duration and cost', () => {
  const status = (content) => mount(FactoryConversation, { props: { thread: THREAD, messages: [msg('system', 'status', content)] } }).get('[data-test=factory-outcome]').text();
  expect(status({ outcome: 'succeeded', durationMs: 72000, costUsd: 0.08 })).toBe('finished · 1m12s · $0.08');
  expect(status({ outcome: 'failed', durationMs: 9000, costUsd: null })).toBe('failed · 9s');
  expect(status({ outcome: 'interrupted', durationMs: null, costUsd: null })).toBe('interrupted by a restart');
  expect(status({ outcome: 'timed-out', durationMs: 125000, costUsd: 1 })).toBe('timed out · 2m05s · $1.00');
});

test('names a skill-started request and the provider in the header', () => {
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages: [msg('user', 'text', 'skill nx/monorepo\n\nextra')] } });
  expect(w.text()).toContain('claude-cli');
  expect(w.get('[data-test=factory-user]').text()).toContain('skill nx/monorepo');
});

test('the Console button in the header asks for the console', async () => {
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages: [], consoleAvailable: true } });
  const button = w.get('[data-test=factory-console-button]');
  expect(button.attributes('disabled')).toBeUndefined();
  expect(button.text()).toContain('Console');
  await button.trigger('click');
  expect(w.emitted('console')).toHaveLength(1);
});

test('the Console button is disabled with the reason when the console is unavailable', () => {
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages: [], consoleAvailable: false, consoleReason: 'no prebuilt' } });
  const button = w.get('[data-test=factory-console-button]');
  expect(button.attributes('disabled')).toBeDefined();
  expect(button.attributes('aria-label')).toBe('Console unavailable: no prebuilt');
});

test('the tabs slot sits under the header and the messages can be hidden', () => {
  const w = mount(FactoryConversation, {
    props: { thread: THREAD, messages: [msg('user', 'text', 'go')], showMessages: false },
    slots: { tabs: '<nav data-test="tabs-slot">tabs</nav>' },
  });
  expect(w.get('header').element.nextElementSibling.getAttribute('data-test')).toBe('tabs-slot');
  expect(w.get('[data-test=factory-user]').isVisible()).toBe(false);
});
