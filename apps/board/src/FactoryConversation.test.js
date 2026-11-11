import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryConversation from './FactoryConversation.vue';

const THREAD = { id: 'th_1', repo: 'api', provider: 'claude-cli', model: 'opus', title: 'Fix it', status: 'idle' };
let n = 0;
const msg = (role, kind, content, runId = 'r1') => ({ id: `m${n += 1}`, threadId: 'th_1', role, kind, content, runId, createdAt: '2026-11-07T10:00:00.000Z' });
const step = (tool) => msg('agent', 'step', { tool, summary: `${tool} x`, input: {} });

const WT = { path: '/wk/.worktrees/api/th_1', branch: 'factory/th_1-fix-it', base: 'origin/main', exists: true, dirty: false, ahead: 2 };
const withWt = (worktree, status = 'idle') => mount(FactoryConversation, { props: { thread: { ...THREAD, status, worktree }, messages: [] } });

test('shows the worktree branch in a badge, only for worktree threads', () => {
  const w = withWt(WT);
  expect(w.get('[data-test=factory-worktree-badge]').text()).toContain('factory/th_1-fix-it');
  expect(w.find('[data-test=factory-worktree-dirty]').exists()).toBe(false);
  expect(w.get('[data-test=factory-worktree-badge]').text()).not.toContain('worktree removed');
  expect(mount(FactoryConversation, { props: { thread: THREAD, messages: [] } }).find('[data-test=factory-worktree-badge]').exists()).toBe(false);
});

test('flags a modified worktree and a missing one, and tolerates unknown git status', () => {
  expect(withWt({ ...WT, dirty: true }).get('[data-test=factory-worktree-dirty]').text()).toBe('modified');
  expect(withWt({ ...WT, exists: false }).get('[data-test=factory-worktree-badge]').text()).toContain('worktree removed');
  const unknown = withWt({ ...WT, dirty: null, ahead: null });
  expect(unknown.find('[data-test=factory-worktree-dirty]').exists()).toBe(false);
  const bare = withWt({ path: WT.path, branch: WT.branch, base: WT.base });
  expect(bare.find('[data-test=factory-worktree-dirty]').exists()).toBe(false);
});

test('the remove button emits remove-worktree and is disabled while running', async () => {
  const w = withWt(WT);
  await w.get('[data-test=factory-worktree-remove]').trigger('click');
  expect(w.emitted('remove-worktree')).toHaveLength(1);
  expect(withWt(WT, 'running').get('[data-test=factory-worktree-remove]').element.disabled).toBe(true);
  expect(w.get('[data-test=factory-worktree-remove]').element.disabled).toBe(false);
});

test('the remove button is disabled while a removal is in flight', () => {
  const w = mount(FactoryConversation, { props: { thread: { ...THREAD, worktree: WT }, messages: [], removingWorktree: true } });
  expect(w.get('[data-test=factory-worktree-remove]').element.disabled).toBe(true);
});

test('the worktree badge is labelled with its branch', () => {
  expect(withWt(WT).get('[data-test=factory-worktree-badge]').attributes('aria-label')).toBe('Worktree factory/th_1-fix-it');
});

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
  expect(groups.map((g) => g.text())).toEqual(['2 steps (Edit ×2)', '1 step (Read)']);
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
    attachTo: document.body, // jsdom 31 reports a detached element as visible
  });
  expect(w.get('header').element.nextElementSibling.getAttribute('data-test')).toBe('tabs-slot');
  expect(w.get('[data-test=factory-user]').isVisible()).toBe(false);
  w.unmount();
});

test('lists the newest message first, keeping the steps of a turn in order', () => {
  const messages = [msg('user', 'text', 'first'), step('Read'), step('Edit'), msg('agent', 'text', 'second')];
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages } });
  const order = w.get('[data-test=factory-messages]').element.children;
  expect([...order].map((el) => el.getAttribute('data-test'))).toEqual(['factory-agent', 'factory-steps', 'factory-user']);
  expect(w.findAll('[data-test=factory-steps] li').map((li) => li.text())).toEqual(['Read Read x', 'Edit Edit x']);
});

test('the composer slot sits above the messages', () => {
  const w = mount(FactoryConversation, {
    props: { thread: THREAD, messages: [msg('user', 'text', 'go')] },
    slots: { composer: '<form data-test="composer-slot" />' },
  });
  expect(w.get('[data-test=composer-slot]').element.nextElementSibling.getAttribute('data-test')).toBe('factory-messages');
});

test('highlights an agent reply that ends on a question', () => {
  const messages = [msg('agent', 'text', 'Done.'), msg('agent', 'text', 'Two options:\n\n- A\n- B\n\n**Which one do you want?**')];
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages } });
  const [question, plain] = w.findAll('[data-test=factory-agent]');
  expect(question.attributes('data-question')).toBeDefined();
  expect(question.text()).toContain('Question for you');
  expect(question.get('.markdown strong').text()).toBe('Which one do you want?');
  expect(plain.attributes('data-question')).toBeUndefined();
  expect(plain.classes()).toContain('markdown');
});

test('the worktree tooltip shows ? when the commits ahead are unknown', async () => {
  vi.useFakeTimers();
  const w = mount(FactoryConversation, { props: { thread: { ...THREAD, worktree: { ...WT, ahead: undefined } }, messages: [] }, attachTo: document.body });
  await w.get('[data-test=factory-worktree-badge]').trigger('mouseenter');
  vi.advanceTimersByTime(2000);
  expect(document.querySelector('[data-test=tooltip]').textContent).toContain('?');
  w.unmount();
  vi.useRealTimers();
});

test('an agent message without content is not a question', () => {
  const w = mount(FactoryConversation, { props: { thread: THREAD, messages: [msg('agent', 'text', null)] } });
  expect(w.get('[data-test=factory-agent]').attributes('data-question')).toBeUndefined();
});
