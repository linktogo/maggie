<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useThreads } from './useThreads.js';
import FactoryProjects from './FactoryProjects.vue';
import FactoryThreads from './FactoryThreads.vue';
import FactoryConversation from './FactoryConversation.vue';
import FactoryComposer from './FactoryComposer.vue';
import FactoryNewRequest from './FactoryNewRequest.vue';
import FactoryConsole from './FactoryConsole.vue';
import Icon from './Icon.vue';
import { vTooltip } from './tooltip.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, required: true },
  EventSourceImpl: { type: Function, default: undefined },
  confirmImpl: { type: Function, default: (message) => window.confirm(message) },
});

const route = useRoute();
const router = useRouter();
const factory = useThreads({ fetchImpl: props.fetchImpl, EventSourceImpl: props.EventSourceImpl });
const { health, skills, projects, threads, thread, messages, error, available, busy, resumable } = factory;

const repo = computed(() => route.params.repo ?? '');
const threadId = computed(() => route.params.threadId ?? '');
const search = ref('');
const archived = ref(false);
const creating = ref(false);
const prefill = ref(null);
const formKey = ref(0);
// The console tab exists only once the Console button was clicked; its shell dies with it.
const consoleOpen = ref(false);
const tab = ref('conversation');

const repos = computed(() => health.value?.repos ?? []);
const providers = computed(() => health.value?.providers?.available ?? []);
const consoleAvailable = computed(() => health.value?.terminal?.available === true);
const consoleReason = computed(() => health.value?.terminal?.reason ?? '');
const current = computed(() => (thread.value?.id === threadId.value ? thread.value : null));
const lastOutcome = computed(() => messages.value.findLast((m) => m.kind === 'status')?.content?.outcome ?? null);
const shownError = computed(() => (available.value ? error.value : null));
// Below md only the deepest selected pane shows.
const depth = computed(() => (creating.value || threadId.value ? 3 : repo.value ? 2 : 1));
const pane = (n, extra = '') => [`${depth.value === n ? 'flex' : 'hidden'} md:flex flex-col gap-3`, extra];
const PANEL = 'bg-surface border border-line rounded-card shadow-panel p-3';
const TAB = '-mb-px border-b-2 px-3 py-1';
const TAB_ON = 'border-accent font-medium text-accent';
const TAB_OFF = 'border-transparent text-ink-muted hover:text-ink';

// A search spans every project; otherwise the list follows the selected one.
const reloadThreads = () => factory.loadThreads({ repo: search.value ? undefined : repo.value || undefined, q: search.value, archived: archived.value });

factory.load();
function closeConsole() {
  consoleOpen.value = false;
  tab.value = 'conversation';
}
function openConsole() {
  consoleOpen.value = true;
  tab.value = 'console';
}

watch(repo, () => { creating.value = false; if (repo.value) void reloadThreads(); }, { immediate: true });
watch(threadId, (id) => {
  closeConsole();
  if (!id) return;
  creating.value = false;
  if (thread.value?.id !== id) void factory.open(id);
}, { immediate: true });

const go = (path) => router.push(path);
const backTo = () => go(threadId.value || creating.value ? `/factory/${repo.value}` : '/factory');
function newRequest(initial = null) {
  prefill.value = initial;
  formKey.value += 1;
  creating.value = true;
  if (threadId.value) void go(`/factory/${repo.value}`);
}
function restart() {
  const text = messages.value.findLast((m) => m.role === 'user' && m.kind === 'text')?.content ?? '';
  const [, skill = '', rest = text] = /^skill (\S+)(?:\n\n)?([\s\S]*)$/.exec(text) ?? [];
  newRequest({ repo: thread.value.repo, provider: thread.value.provider, model: thread.value.model, prompt: rest, skill });
}
async function create(body) {
  const created = await factory.create(body);
  if (created) { creating.value = false; await go(`/factory/${created.repo}/${created.id}`); }
}
// Two confirmations: removing, then forcing when the worktree holds uncommitted changes.
async function removeWorktree() {
  if (!props.confirmImpl(t('factory.worktree.confirm'))) return;
  const { id } = current.value;
  const result = await factory.removeWorktree(id);
  if (result.dirty && props.confirmImpl(t('factory.worktree.confirmForce'))) await factory.removeWorktree(id, { force: true });
}
function onSearch(q) { search.value = q; void reloadThreads(); }
function toggleArchived() { archived.value = !archived.value; void reloadThreads(); }
async function archive(id) {
  if (await factory.archive(id) && id === threadId.value) await go(`/factory/${repo.value}`);
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!available" data-test="factory-unavailable" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.unavailable') }} {{ t('factory.startHint') }}
    </p>
    <p v-else-if="providers.length === 0" data-test="factory-no-provider" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noProvider') }}
    </p>
    <p v-else-if="repos.length === 0" data-test="factory-no-repos" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noRepos') }}
    </p>

    <button v-if="depth > 1" type="button" data-test="factory-back" class="self-start text-sm text-accent hover:underline md:hidden" @click="backTo">
      ← {{ t('factory.back') }}
    </button>

    <div class="grid gap-4 md:grid-cols-[14rem_18rem_minmax(0,1fr)]">
      <section :class="pane(1, PANEL)" :aria-label="t('factory.projects')">
        <FactoryProjects :projects="projects" :selected="repo" @select="(name) => go(`/factory/${name}`)" @search="onSearch" />
      </section>

      <section :class="pane(2, PANEL)" :aria-label="t('factory.requests')">
        <FactoryThreads
          v-if="repo || search"
          :threads="threads" :selected="threadId" :archived="archived"
          @select="(id) => go(`/factory/${threads.find((x) => x.id === id)?.repo ?? repo}/${id}`)"
          @new="newRequest()" @toggle-archived="toggleArchived" @archive="archive" @restore="factory.restore"
        />
        <p v-else data-test="factory-pick-project" class="text-xs text-ink-faint">{{ t('factory.pickProject') }}</p>
      </section>

      <section :class="pane(3, PANEL)" :aria-label="t('factory.conversation')">
        <FactoryNewRequest
          v-if="creating"
          :key="formKey"
          :repos="repos" :providers="providers" :skills="skills" :available="available" :busy="busy"
          :default-provider="health?.providers?.default ?? ''" :repo="repo" :prefill="prefill" :error="shownError"
          @submit="create"
        />
        <template v-else-if="current">
          <FactoryConversation
            :thread="current" :messages="messages" :show-messages="tab === 'conversation'"
            :console-available="consoleAvailable" :console-reason="consoleReason" @console="openConsole" @remove-worktree="removeWorktree"
          >
            <template v-if="consoleOpen" #tabs>
              <div role="tablist" data-test="factory-tabs" class="flex items-end gap-1 border-b border-line text-sm">
                <button
                  type="button" role="tab" data-test="factory-tab-conversation" :aria-selected="tab === 'conversation'"
                  :class="[TAB, tab === 'conversation' ? TAB_ON : TAB_OFF]" @click="tab = 'conversation'"
                >{{ t('factory.conversation') }}</button>
                <span :class="[TAB, 'inline-flex items-center gap-1', tab === 'console' ? TAB_ON : TAB_OFF]">
                  <button type="button" role="tab" data-test="factory-tab-console" :aria-selected="tab === 'console'" @click="tab = 'console'">
                    {{ t('factory.console.tab') }}
                  </button>
                  <button
                    type="button" data-test="factory-console-close" :aria-label="t('factory.console.close')" v-tooltip="t('factory.console.close')"
                    class="text-ink-faint hover:text-ink" @click="closeConsole"
                  ><Icon name="close" emoji="✕" /></button>
                </span>
              </div>
            </template>
            <template #composer>
              <FactoryComposer
                v-show="tab === 'conversation'"
                :thread="current" :resumable="resumable" :error="shownError" :last-outcome="lastOutcome"
                :busy="busy" :send="factory.reply" @stop="factory.stop" @restart="restart"
              />
            </template>
          </FactoryConversation>
          <FactoryConsole
            v-if="consoleOpen" v-show="tab === 'console'" data-test="factory-console"
            :thread="current.id" :fetch-impl="fetchImpl" :EventSourceImpl="EventSourceImpl"
          />
        </template>
        <p v-else data-test="factory-pick-thread" class="text-xs text-ink-faint">{{ t('factory.pickThread') }}</p>
      </section>
    </div>
  </div>
</template>
