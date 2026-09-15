import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Card from './Card.vue';
import SessionRow from './SessionRow.vue';

const now = Date.parse('2026-06-21T10:00:00.000Z');

function session(overrides = {}) {
  return {
    sessionId: 's1', status: 'todo', lastEvent: 'init',
    updatedAt: '2026-06-21T09:59:00.000Z', title: 'fix login', lastPrompt: 'fix login', events: [],
    ...overrides,
  };
}

test('renders the repo name and one row per session', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session(), session({ sessionId: 's2', title: 'add tests' })], status: 'inprogress', now } });
  expect(w.text()).toContain('oc-be');
  expect(w.text()).toContain('fix login');
  expect(w.text()).toContain('add tests');
  expect(w.findAll('[data-test=session-row]')).toHaveLength(2);
});

test('shows a placeholder when the repo has no active sessions', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [], status: 'todo', now } });
  expect(w.text()).toContain('No active session');
});

test('highlights a question card', () => {
  const w = mount(Card, { props: { name: 'oc-auth', sessions: [session()], status: 'question', now } });
  expect(w.classes().join(' ')).toContain('ring-question-ring');
});

test('emits "open" with the repo name and session id when a row is clicked', async () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now } });
  await w.get('[data-test=session-row]').trigger('click');
  expect(w.emitted('open')[0]).toEqual([{ name: 'oc-be', sessionId: 's1' }]);
});

test('passes its repo name down to each session row', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now } });
  expect(w.findComponent(SessionRow).props('repoName')).toBe('oc-be');
});

test('renders one badge per contributor, worst first', () => {
  const ci = { users: { zoe: { state: 'success' }, alice: { state: 'failure' } } };
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now, ci } });
  const badges = w.findAll('[data-test=ci-badge]');
  expect(badges.map((b) => b.text())).toEqual(['AL', 'ZO']);
  expect(badges[0].classes().join(' ')).toContain('red');
});

test('collapses beyond four contributors into a +N badge', () => {
  const users = {};
  for (const login of ['a1', 'b2', 'c3', 'd4', 'e5']) users[login] = { state: 'success' };
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now, ci: { users } } });
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(4);
  expect(w.get('[data-test=ci-overflow]').text()).toBe('+1');
});

test('renders no badges when the repo has no CI status', () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now } });
  expect(w.findAll('[data-test=ci-badge]')).toHaveLength(0);
  expect(w.find('[data-test=ci-overflow]').exists()).toBe(false);
});

test('badges expose state through aria-label, not colour alone', () => {
  const users = {};
  for (const login of ['a1', 'b2', 'c3', 'd4', 'e5']) users[login] = { state: 'success' };
  users.alice = { state: 'failure' };
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'todo', now, ci: { users } } });
  const badge = w.get('[data-test=ci-badge]');
  expect(badge.attributes('aria-label')).toContain('alice');
  expect(badge.attributes('aria-label')).toContain('failure');
  const overflow = w.get('[data-test=ci-overflow]');
  expect(overflow.attributes('aria-label')).toBeTruthy();
});

test('forwards send-message from a session row up to the parent', async () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [session()], status: 'question', now } });
  await w.findComponent(SessionRow).vm.$emit('send-message', { repo: 'oc-be', sessionId: 's1', text: 'hi' });
  expect(w.emitted('send-message')[0]).toEqual([{ repo: 'oc-be', sessionId: 's1', text: 'hi' }]);
});

test('clicking the repo name opens the repo detail, with no session selected', async () => {
  const w = mount(Card, { props: { name: 'oc-be', sessions: [], status: 'todo' } });
  await w.get('[data-test=open-repo]').trigger('click');
  expect(w.emitted('open')[0]).toEqual([{ name: 'oc-be', sessionId: null }]);
});
