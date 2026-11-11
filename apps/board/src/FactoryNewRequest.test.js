import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FactoryNewRequest from './FactoryNewRequest.vue';

const PROPS = {
  repos: ['api', 'web'],
  providers: ['claude-cli', 'copilot'],
  defaultProvider: 'copilot',
  skills: [{ id: 'nx/monorepo' }],
};
const form = (props = {}) => mount(FactoryNewRequest, { props: { ...PROPS, ...props }, attachTo: document.body });

test('the form offers the repos and providers, preselecting the default provider', () => {
  const w = form();
  expect(w.findAll('[data-test=factory-repo] option').map((o) => o.text())).toEqual(['api', 'web']);
  expect(w.findAll('[data-test=factory-provider] option').map((o) => o.element.value)).toEqual(['claude-cli', 'copilot']);
  expect(w.get('[data-test=factory-provider]').element.value).toBe('copilot');
  expect(w.get('[data-test=factory-repo]').element.value).toBe('api');
});

test('the selected project is preselected', () => {
  expect(form({ repo: 'web' }).get('[data-test=factory-repo]').element.value).toBe('web');
});

test('a default provider that is not installed falls back to the first available one', () => {
  expect(form({ providers: ['claude-cli'] }).get('[data-test=factory-provider]').element.value).toBe('claude-cli');
});

test('the run button waits for a prompt', async () => {
  const w = form();
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-prompt]').setValue('fix the failing test');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
});

test('submitting emits the chosen repo, provider, model and prompt', async () => {
  const w = form();
  await w.get('[data-test=factory-repo]').setValue('web');
  await w.get('[data-test=factory-provider]').setValue('claude-cli');
  await w.get('[data-test=factory-model]').setValue(' sonnet ');
  await w.get('[data-test=factory-prompt]').setValue(' fix it ');
  await w.get('form').trigger('submit');
  expect(w.emitted('submit')).toEqual([[{ repo: 'web', provider: 'claude-cli', model: 'sonnet', prompt: 'fix it', skill: '', worktree: true }]]);
});

test('the isolated worktree box is checked by default and can be cleared', async () => {
  const w = form();
  expect(w.get('[data-test=factory-worktree]').element.checked).toBe(true);
  await w.get('[data-test=factory-worktree]').setValue(false);
  await w.get('[data-test=factory-prompt]').setValue('fix it');
  await w.get('form').trigger('submit');
  expect(w.emitted('submit')[0][0].worktree).toBe(false);
});

test('Enter in the prompt submits, Shift+Enter does not', async () => {
  const w = form();
  const prompt = w.get('[data-test=factory-prompt]');
  await prompt.setValue('fix it');
  await prompt.trigger('keydown', { key: 'Enter', shiftKey: true });
  expect(w.emitted('submit')).toBeUndefined();
  await prompt.trigger('keydown', { key: 'Enter' });
  expect(w.emitted('submit')).toEqual([[{ repo: 'api', provider: 'copilot', model: '', prompt: 'fix it', skill: '', worktree: true }]]);
});

test('Enter does not submit an incomplete request', async () => {
  const w = form();
  await w.get('[data-test=factory-prompt]').trigger('keydown', { key: 'Enter' });
  expect(w.emitted('submit')).toBeUndefined();
});

test('skill mode needs a skill, the prompt becoming extra instructions', async () => {
  const w = form();
  await w.get('[data-test=factory-mode-skill]').setValue(true);
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(true);
  await w.get('[data-test=factory-skill]').setValue('nx/monorepo');
  expect(w.get('[data-test=factory-run]').element.disabled).toBe(false);
  await w.get('form').trigger('submit');
  expect(w.emitted('submit')[0][0]).toMatchObject({ repo: 'api', provider: 'copilot', skill: 'nx/monorepo', prompt: '' });
});

test('switching back from skill mode to prompt mode hides the skill picker', async () => {
  const w = form();
  await w.get('[data-test=factory-mode-skill]').setValue(true);
  expect(w.find('[data-test=factory-skill]').exists()).toBe(true);
  await w.get('[data-test=factory-mode-prompt]').setValue(true);
  expect(w.find('[data-test=factory-skill]').exists()).toBe(false);
});

test('the form is disabled when the agents server is unavailable, has no provider or no repo', () => {
  expect(form({ available: false }).get('[data-test=factory-run]').element.disabled).toBe(true);
  expect(form({ providers: [] }).get('[data-test=factory-run]').element.disabled).toBe(true);
  expect(form({ repos: [] }).get('[data-test=factory-run]').element.disabled).toBe(true);
});

test('prefills from a restart', () => {
  const w = form({ prefill: { repo: 'web', provider: 'claude-cli', model: 'opus', prompt: 'try again' } });
  expect(w.get('[data-test=factory-repo]').element.value).toBe('web');
  expect(w.get('[data-test=factory-provider]').element.value).toBe('claude-cli');
  expect(w.get('[data-test=factory-model]').element.value).toBe('opus');
  expect(w.get('[data-test=factory-prompt]').element.value).toBe('try again');
});

test('shows an error', () => {
  expect(form({ error: 'a run is already active on api' }).get('[data-test=factory-error]').text()).toContain('already active');
});
