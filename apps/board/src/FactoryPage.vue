<script setup>
import { computed, reactive } from 'vue';
import { useFactory } from './useFactory.js';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, required: true },
  EventSourceImpl: { type: Function, default: undefined },
});

const factory = useFactory({ fetchImpl: props.fetchImpl, EventSourceImpl: props.EventSourceImpl });
const { health, skills, runs, output, followed, error, available } = factory;

const form = reactive({ repo: '', provider: '', model: '', mode: 'prompt', skill: '', prompt: '' });

const repos = computed(() => health.value?.repos ?? []);
const providers = computed(() => health.value?.providers?.available ?? []);

// Until the user picks, the form shows the first repo and the server's default provider.
const repo = computed(() => form.repo || repos.value[0] || '');
const provider = computed(() => {
  if (form.provider) return form.provider;
  const preferred = health.value?.providers?.default;
  return providers.value.includes(preferred) ? preferred : (providers.value[0] ?? '');
});

const canRun = computed(() => available.value && repo.value && provider.value
  && (form.mode === 'skill' ? form.skill : form.prompt.trim()));

function run() {
  return factory.start({
    repo: repo.value,
    provider: provider.value,
    model: form.model.trim(),
    prompt: form.prompt.trim(),
    skill: form.mode === 'skill' ? form.skill : '',
  });
}

const FIELD = 'rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink-soft focus:border-accent focus:outline-hidden disabled:opacity-40';
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h2 class="font-bold text-ink-strong">{{ t('factory.title') }}</h2>
      <p class="mt-1 text-sm text-ink-soft">{{ t('factory.intro') }}</p>
    </div>

    <p v-if="!available" data-test="factory-unavailable" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.unavailable') }} {{ t('factory.startHint') }}
    </p>
    <p v-else-if="providers.length === 0" data-test="factory-no-provider" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noProvider') }}
    </p>
    <p v-else-if="repos.length === 0" data-test="factory-no-repos" class="text-xs text-question-on-soft">
      <Icon name="warning" emoji="⚠" /> {{ t('factory.noRepos') }}
    </p>

    <form class="bg-surface border border-line rounded-card shadow-panel p-4 flex flex-col gap-3" @submit.prevent="run">
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.repo') }}
          <select data-test="factory-repo" :class="FIELD" :value="repo" :disabled="!available" @change="form.repo = $event.target.value">
            <option v-for="name in repos" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.provider') }}
          <select data-test="factory-provider" :class="FIELD" :value="provider" :disabled="!available" @change="form.provider = $event.target.value">
            <option v-for="name in providers" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.model') }}
          <input v-model="form.model" data-test="factory-model" :class="FIELD" :placeholder="t('factory.modelPlaceholder')" :disabled="!available">
        </label>
      </div>

      <div class="flex gap-4 text-sm text-ink-soft">
        <label class="flex items-center gap-1">
          <input v-model="form.mode" data-test="factory-mode-prompt" type="radio" value="prompt"> {{ t('factory.modePrompt') }}
        </label>
        <label class="flex items-center gap-1">
          <input v-model="form.mode" data-test="factory-mode-skill" type="radio" value="skill"> {{ t('factory.modeSkill') }}
        </label>
      </div>

      <label v-if="form.mode === 'skill'" class="flex flex-col gap-1 text-xs text-ink-muted">{{ t('factory.skill') }}
        <select v-model="form.skill" data-test="factory-skill" :class="FIELD" :disabled="!available">
          <option value="">{{ t('factory.skillNone') }}</option>
          <option v-for="skill in skills" :key="skill.id" :value="skill.id">{{ skill.id }}</option>
        </select>
      </label>

      <label class="flex flex-col gap-1 text-xs text-ink-muted">{{ form.mode === 'skill' ? t('factory.extraPrompt') : t('factory.prompt') }}
        <textarea v-model="form.prompt" data-test="factory-prompt" rows="4" :class="FIELD" :disabled="!available" />
      </label>

      <p v-if="error" data-test="factory-error" class="text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ error }}</p>

      <div>
        <button
          type="submit"
          data-test="factory-run"
          :disabled="!canRun"
          class="whitespace-nowrap rounded-control bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
        >{{ t('factory.run') }}</button>
      </div>
    </form>

    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h3 class="font-semibold text-ink-strong text-sm">{{ t('factory.runs') }}</h3>
      <p v-if="runs.length === 0" data-test="factory-no-runs" class="mt-2 text-xs text-ink-faint">{{ t('factory.noRuns') }}</p>
      <ul v-else class="mt-2 flex flex-col gap-1 text-sm">
        <li v-for="item in runs" :key="item.id" :data-test="`factory-run-row-${item.id}`" class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-ink">{{ item.repo }}</span>
          <span class="text-xs text-ink-faint">{{ item.skill ?? 'prompt' }} · {{ item.provider }}</span>
          <span :class="['text-xs', item.status === 'failed' || item.status === 'timed-out' ? 'text-question-on-soft' : 'text-ink-soft']">{{ t(`factory.status.${item.status}`) }}</span>
          <button type="button" :data-test="`factory-follow-${item.id}`" class="text-xs text-accent hover:underline" @click="factory.follow(item.id)">{{ t('factory.follow') }}</button>
          <button v-if="item.status === 'running'" type="button" :data-test="`factory-stop-${item.id}`" class="text-xs text-accent hover:underline" @click="factory.cancel(item.id)">{{ t('factory.stop') }}</button>
        </li>
      </ul>
    </div>

    <div class="bg-surface border border-line rounded-card shadow-panel p-4">
      <h3 class="font-semibold text-ink-strong text-sm">{{ t('factory.output') }}<span v-if="followed" class="font-normal text-ink-faint"> · {{ followed }}</span></h3>
      <p v-if="!followed" data-test="factory-no-output" class="mt-2 text-xs text-ink-faint">{{ t('factory.noOutput') }}</p>
      <pre v-else data-test="factory-output" class="mt-2 max-h-96 overflow-auto rounded-control bg-surface-muted p-2 text-xs text-ink-soft whitespace-pre-wrap"><template v-for="(line, index) in output" :key="index"><span :class="line.type === 'stderr' ? 'text-question-on-soft' : ''">{{ line.type === 'status' ? `— ${line.text}\n` : line.text }}</span></template></pre>
    </div>
  </div>
</template>
