<script setup>
import { computed, reactive } from 'vue';
import { useRetroDoc } from './useRetroDoc.js';
import { relativeTime } from './useRelativeTime.js';
import RetroDocLog from './RetroDocLog.vue';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  config: { type: Object, required: true },
  now: { type: Number, default: () => Date.now() },
  fetchImpl: { type: Function, required: true },
});

const { jobs, error, available, start, latestFor } = useRetroDoc({ fetchImpl: props.fetchImpl });

// One choice of LLM per repository, so a run on one does not change the others.
const providers = reactive({});
const providerFor = (repo) => providers[repo] ?? 'claude';

const rows = computed(() => Object.entries(props.config)
  .map(([name, meta]) => ({ name, meta: meta ?? {} }))
  .sort((a, b) => a.name.localeCompare(b.name)));

// Reading jobs here is what keeps the rows following a running job.
const jobFor = (repo) => (jobs.value ? latestFor(repo) : null);

// The row shows the head of the last line — "digest 2/5: 5 document(s)" — and
// leaves the rest (the paths it is chewing on) to the console below it.
const lastLine = (repo) => {
  const text = jobFor(repo)?.log?.at(-1)?.text;
  return text ? text.trim().split(' — ')[0] : null;
};

// The console is open by default while a run is in flight — that is the moment
// it is worth looking at — and can be pinned open or shut per row afterwards.
const opened = reactive({});
const isOpen = (repo) => opened[repo] ?? jobFor(repo)?.status === 'running';
const toggle = (repo) => { opened[repo] = !isOpen(repo); };

// How long the run has been going, so a slow call reads as slow, not as frozen.
function elapsed(repo) {
  const job = jobFor(repo);
  if (!job?.startedAt) return null;
  const seconds = Math.max(0, Math.round((props.now - Date.parse(job.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function generate(repo) {
  opened[repo] = true;
  start(repo, providerFor(repo));
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h2 class="font-bold text-ink-strong">{{ t('retro.title') }}</h2>
      <p class="mt-1 text-sm text-ink-soft">{{ t('retro.intro') }}</p>
      <p class="mt-1 text-xs text-ink-faint">{{ t('retro.writes') }}</p>
    </div>

    <p v-if="!available" data-test="retro-unavailable" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('detail.retroDocUnavailable') }}
    </p>
    <p v-else-if="error" data-test="retro-error" class="text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ error }}</p>

    <div v-if="rows.length === 0" data-test="retro-empty" class="bg-surface border border-line rounded-card shadow-panel p-4 text-sm text-ink-muted">
      {{ t('retro.noRepos') }}
    </div>

    <div v-else class="bg-surface border border-line rounded-card shadow-panel overflow-x-auto">
      <table class="w-full min-w-[40rem] text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-ink-muted bg-surface-muted border-b border-line">
          <tr>
            <th class="px-4 py-2 font-semibold">{{ t('retro.repo') }}</th>
            <th class="px-4 py-2 font-semibold">{{ t('retro.llm') }}</th>
            <th class="px-4 py-2 font-semibold">{{ t('retro.lastRun') }}</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name" :data-test="`retro-row-${row.name}`" class="border-b border-line-soft last:border-0 align-top hover:bg-surface-hover transition-colors">
            <td class="px-4 py-3">
              <div class="font-medium text-ink">{{ row.name }}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                <span v-for="tech in (row.meta.technologies || [])" :key="tech" class="text-xs font-medium bg-surface-muted text-ink-soft px-2 py-0.5 rounded-chip">{{ tech }}</span>
              </div>
            </td>
            <td class="px-4 py-3">
              <select
                :value="providerFor(row.name)"
                :data-test="`retro-provider-${row.name}`"
                :disabled="!available"
                class="rounded-control border border-line bg-surface px-2 py-1 text-xs text-ink-soft focus:border-accent focus:outline-hidden disabled:opacity-40"
                @change="providers[row.name] = $event.target.value"
              >
                <option value="claude">Claude (API)</option>
                <option value="claude-cli">Claude Code (CLI)</option>
                <option value="copilot">GitHub Copilot (CLI)</option>
              </select>
            </td>
            <td class="px-4 py-3 text-xs">
              <span v-if="!jobFor(row.name)" :data-test="`retro-never-${row.name}`" class="text-ink-faint">{{ t('retro.never') }}</span>
              <span v-else-if="jobFor(row.name).status === 'running'" :data-test="`retro-running-${row.name}`" class="text-ink-soft">
                ⏳ {{ lastLine(row.name) ?? t('detail.retroDocRunning') }}
                <span v-if="elapsed(row.name)" class="text-ink-faint">· {{ t('retro.elapsed', { elapsed: elapsed(row.name) }) }}</span>
              </span>
              <span v-else-if="jobFor(row.name).status === 'done'" :data-test="`retro-done-${row.name}`" class="text-ink-soft">
                ✓ {{ t('detail.retroDocDone', { out: jobFor(row.name).out }) }}
                <span v-if="jobFor(row.name).files?.length > 1">· {{ t('retro.files', { count: jobFor(row.name).files.length }) }}</span>
                · {{ jobFor(row.name).generator }}
                · {{ relativeTime(jobFor(row.name).finishedAt, now) }}
              </span>
              <span v-else :data-test="`retro-failed-${row.name}`" class="text-question-on-soft">
                <Icon name="warning" emoji="⚠" /> {{ t('detail.retroDocFailed', { reason: jobFor(row.name).error }) }}
              </span>
              <button
                v-if="jobFor(row.name)?.log?.length"
                type="button"
                :data-test="`retro-toggle-log-${row.name}`"
                class="ml-1 text-accent hover:underline"
                @click="toggle(row.name)"
              >{{ isOpen(row.name) ? t('retro.hideLog') : t('retro.showLog') }}</button>
              <RetroDocLog v-if="isOpen(row.name) && jobFor(row.name)?.log?.length" :log="jobFor(row.name).log" />
            </td>
            <td class="px-4 py-3 text-right">
              <button
                type="button"
                :data-test="`retro-run-${row.name}`"
                :disabled="!available || jobFor(row.name)?.status === 'running'"
                class="whitespace-nowrap rounded-control bg-accent px-3 py-1 text-xs font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
                @click="generate(row.name)"
              >{{ jobFor(row.name)?.status === 'running' ? t('detail.retroDocRunning') : t('detail.retroDocRun') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
