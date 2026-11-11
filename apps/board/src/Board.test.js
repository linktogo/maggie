import { test, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import Board from './Board.vue';
import Card from './Card.vue';
import Column from './Column.vue';
import FilterBar from './FilterBar.vue';
import RepoDetail from './RepoDetail.vue';

afterEach(() => { vi.restoreAllMocks(); });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function mountBoard(props = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(ok({ jobs: [] }));
  const refresh = vi.fn().mockResolvedValue();
  const wrapper = mount(Board, {
    props: {
      repos: {
        api: { sessions: { s1: { status: 'question', title: 'fix login', events: [] } } },
        web: {}, // no sessions object at all: still a "todo" placeholder card
      },
      config: { api: { technologies: ['nestjs'] }, web: {} },
      now: Date.now(),
      fetchImpl,
      refresh,
      ...props,
    },
  });
  return { wrapper, fetchImpl, refresh };
}

const cardNames = (wrapper) => wrapper.findAllComponents(Card).map((c) => c.props('name'));

test('a repo with no sessions object gets a todo placeholder card', async () => {
  const { wrapper } = mountBoard();
  await flushPromises();
  const todo = wrapper.findAllComponents(Column).find((c) => c.props('status') === 'todo');
  expect(todo.props('entries')).toEqual([{ name: 'web', sessions: [] }]);
});

test('the technology filter lists the configured technologies and keeps only matching repos', async () => {
  const { wrapper } = mountBoard({ repos: { api: {}, web: {}, orphan: {} } });
  const bar = wrapper.findComponent(FilterBar);
  expect(bar.props('technologies')).toEqual(['nestjs']);
  bar.vm.$emit('update:tech', 'nestjs');
  await flushPromises();
  expect(cardNames(wrapper)).toEqual(['api']);
});

test('the name and CI filters narrow the cards', async () => {
  const { wrapper } = mountBoard({
    repos: { api: {}, web: {} },
    ci: { api: { users: { alice: { state: 'failure' } } } },
  });
  const bar = wrapper.findComponent(FilterBar);
  bar.vm.$emit('update:name', 'WE');
  await flushPromises();
  expect(cardNames(wrapper)).toEqual(['web']);
  bar.vm.$emit('update:name', '');
  bar.vm.$emit('update:ci', 'failure');
  await flushPromises();
  expect(cardNames(wrapper)).toEqual(['api']);
});

test('closing an unknown session confirms with its id as the label', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { wrapper, fetchImpl, refresh } = mountBoard();
  wrapper.findAllComponents(Column)[0].vm.$emit('close-session', { repo: 'gone', sessionId: 'zz9' });
  await flushPromises();
  expect(confirm.mock.calls[0][0]).toContain('zz9');
  expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/close', expect.objectContaining({ method: 'POST' }));
  expect(refresh).toHaveBeenCalled();
});

test('the detail panel opens on a repo without CI data, starts a retro-doc and closes again', async () => {
  const { wrapper, fetchImpl } = mountBoard();
  wrapper.findAllComponents(Column)[0].vm.$emit('open', { name: 'api', sessionId: 's1' });
  await flushPromises();
  const detail = wrapper.findComponent(RepoDetail);
  expect(detail.props('name')).toBe('api');
  expect(detail.props('ci')).toBeNull();
  expect(detail.props('meta')).toEqual({ technologies: ['nestjs'] });

  detail.vm.$emit('generate-retro-doc', { repo: 'api', provider: 'claude' });
  await flushPromises();
  expect(fetchImpl).toHaveBeenCalledWith('/api/retro-doc', expect.objectContaining({ method: 'POST' }));

  detail.vm.$emit('close');
  await flushPromises();
  expect(detail.props('name')).toBeNull();
});

test('the detail panel has no meta for a repo missing from the config', async () => {
  const { wrapper } = mountBoard({ config: {} });
  wrapper.findAllComponents(Column)[0].vm.$emit('open', { name: 'api', sessionId: 's1' });
  await flushPromises();
  expect(wrapper.findComponent(RepoDetail).props('meta')).toBeNull();
});

test('a message sent from a column is posted to the API, then the board refreshes', async () => {
  const { wrapper, fetchImpl, refresh } = mountBoard();
  wrapper.findAllComponents(Column)[0].vm.$emit('send-message', { repo: 'api', sessionId: 's1', text: 'go on' });
  await flushPromises();
  expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/message', expect.objectContaining({
    body: JSON.stringify({ repo: 'api', sessionId: 's1', message: 'go on' }),
  }));
  expect(refresh).toHaveBeenCalled();
});
