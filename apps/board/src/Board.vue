<script setup>
import { computed, ref } from 'vue';
import Column from './Column.vue';
import SummaryHeader from './SummaryHeader.vue';
import FilterBar from './FilterBar.vue';
import RepoDetail from './RepoDetail.vue';
import { STATUS_ORDER } from './statusStyles.js';
import { matchesCiFilter } from './ciBadge.js';
import { countSync, matchesSyncFilter } from './syncStatus.js';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';
import { useRetroDoc } from './useRetroDoc.js';

const { t } = useI18n();

const props = defineProps({
  repos: { type: Object, required: true },
  config: { type: Object, required: true },
  ci: { type: Object, default: () => ({}) },
  sync: { type: Object, default: () => ({}) },
  now: { type: Number, required: true },
  fetchImpl: { type: Function, required: true },
  refresh: { type: Function, required: true },
  dayCost: { type: Number, default: null },
  dayPartial: { type: Boolean, default: false },
});

const {
  available: retroDocAvailable,
  start: startRetroDoc,
  latestFor: latestRetroDoc,
  jobs: retroDocJobs,
} = useRetroDoc({ fetchImpl: props.fetchImpl });

const nameFilter = ref('');
const techFilter = ref('');
const ciFilter = ref('');
const syncFilter = ref('');
const selected = ref(null); // { name, sessionId } | null

const technologies = computed(() => {
  const set = new Set();
  for (const meta of Object.values(props.config)) for (const t of meta.technologies ?? []) set.add(t);
  return [...set].sort();
});

const filtered = computed(() => {
  const out = {};
  for (const [name, repo] of Object.entries(props.repos)) {
    if (nameFilter.value && !name.toLowerCase().includes(nameFilter.value.toLowerCase())) continue;
    if (techFilter.value && !(props.config[name]?.technologies ?? []).includes(techFilter.value)) continue;
    if (!matchesCiFilter(props.ci[name]?.users, ciFilter.value)) continue;
    if (!matchesSyncFilter(props.sync[name], syncFilter.value)) continue;
    out[name] = repo;
  }
  return out;
});

// A repo's card shows up in every column that has at least one of its
// sessions; each column's copy lists only that column's sessions. A repo
// with no sessions at all still shows a placeholder card in "todo".
function entriesFor(status) {
  const out = [];
  for (const [name, repoEntry] of Object.entries(filtered.value)) {
    const allSessions = Object.entries(repoEntry.sessions ?? {});
    if (allSessions.length === 0) {
      if (status === 'todo') out.push({ name, sessions: [] });
      continue;
    }
    const sessions = allSessions
      .filter(([, s]) => s.status === status)
      .map(([sessionId, s]) => ({ sessionId, ...s }));
    if (sessions.length > 0) out.push({ name, sessions });
  }
  return out;
}
const grouped = computed(() => STATUS_ORDER.map((status) => ({
  status,
  title: t(`status.${status}`),
  entries: entriesFor(status),
})));

async function onCloseSession({ repo, sessionId }) {
  const label = props.repos[repo]?.sessions?.[sessionId]?.title ?? sessionId;
  if (!window.confirm(t('card.confirmClose', { title: label, repo }))) return;
  await props.fetchImpl('/api/sessions/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, sessionId }),
  });
  await props.refresh();
}

async function onGenerateRetroDoc({ repo, provider }) {
  await startRetroDoc(repo, provider);
}

async function onSendMessage({ repo, sessionId, text }) {
  await props.fetchImpl('/api/sessions/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, sessionId, message: text }),
  });
  await props.refresh();
}

const selectedRepo = computed(() => (selected.value ? props.repos[selected.value.name] : null));
const selectedSession = computed(() => selectedRepo.value?.sessions?.[selected.value?.sessionId] ?? null);
const selectedMeta = computed(() => (selected.value ? props.config[selected.value.name] ?? null : null));
const selectedCi = computed(() => (selected.value ? props.ci[selected.value.name] ?? null : null));
const syncCounts = computed(() => countSync(props.sync, Object.keys(props.repos)));
const selectedSync = computed(() => (selected.value ? props.sync[selected.value.name] ?? null : null));
// Reading retroDocJobs here is what makes the panel follow a running job:
// latestFor() alone would not be a reactive dependency.
const selectedRetroDoc = computed(() => (selected.value && retroDocJobs.value ? latestRetroDoc(selected.value.name) : null));
</script>

<template>
  <div>
    <div class="flex items-center gap-2 flex-wrap mb-4">
      <FilterBar
        :name="nameFilter" :tech="techFilter" :ci="ciFilter" :sync="syncFilter" :technologies="technologies"
        @update:name="nameFilter = $event" @update:tech="techFilter = $event" @update:ci="ciFilter = $event"
        @update:sync="syncFilter = $event"
      />
    </div>

    <p v-if="syncCounts.drift || syncCounts.error" data-test="sync-banner" class="alert mb-4">
      <Icon name="warning" emoji="⚠" :size="16" />
      <span>
        <template v-if="syncCounts.drift">{{ t('banner.syncDrift', { count: syncCounts.drift }) }}</template>
        <template v-if="syncCounts.drift && syncCounts.error"> · </template>
        <template v-if="syncCounts.error">{{ t('banner.syncError', { count: syncCounts.error }) }}</template>
      </span>
      <button
        v-if="syncCounts.drift && syncFilter !== 'drift'"
        type="button" data-test="sync-banner-show"
        class="ml-auto shrink-0 text-xs font-medium text-accent underline"
        @click="syncFilter = 'drift'"
      >{{ t('banner.syncShow') }}</button>
    </p>

    <SummaryHeader :repos="repos" :day-cost="dayCost" :day-partial="dayPartial" />

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-gutter">
      <Column
        v-for="c in grouped" :key="c.status"
        :title="c.title" :status="c.status" :entries="c.entries" :now="now" :ci="ci" :sync="sync"
        @open="selected = $event"
        @close-session="onCloseSession"
        @send-message="onSendMessage"
      />
    </div>

    <RepoDetail
      :name="selected?.name ?? null" :session-id="selected?.sessionId ?? null"
      :session="selectedSession" :meta="selectedMeta" :ci="selectedCi" :sync="selectedSync" :now="now"
      :retro-doc="selectedRetroDoc" :retro-doc-available="retroDocAvailable"
      @close="selected = null"
      @send-message="onSendMessage"
      @generate-retro-doc="onGenerateRetroDoc"
    />
  </div>
</template>
