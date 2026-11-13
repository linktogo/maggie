<script setup>
import { computed, reactive } from 'vue';
import Icon from './Icon.vue';
import { vTooltip } from './tooltip.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  repos: { type: Array, default: () => [] },
  providers: { type: Array, default: () => [] },
  defaultProvider: { type: String, default: '' },
  skills: { type: Array, default: () => [] },
  available: { type: Boolean, default: true },
  busy: { type: Boolean, default: false },
  error: { type: String, default: null },
  // Preselected project, or the previous request of a restart.
  repo: { type: String, default: '' },
  prefill: { type: Object, default: null },
});
const emit = defineEmits(['submit']);

const form = reactive({
  repo: props.prefill?.repo ?? '',
  provider: props.prefill?.provider ?? '',
  model: props.prefill?.model ?? '',
  mode: props.prefill?.skill ? 'skill' : 'prompt',
  skill: props.prefill?.skill ?? '',
  prompt: props.prefill?.prompt ?? '',
  worktree: true,
});

// Until the user picks, the form shows the selected project (or the first repo) and the server's default provider.
const repo = computed(() => form.repo || (props.repos.includes(props.repo) ? props.repo : '') || props.repos[0] || '');
const provider = computed(() => {
  if (form.provider) return form.provider;
  return props.providers.includes(props.defaultProvider) ? props.defaultProvider : (props.providers[0] ?? '');
});

const canRun = computed(() => props.available && !props.busy && repo.value && provider.value
  && (form.mode === 'skill' ? form.skill : form.prompt.trim()));

function submit() {
  // Enter in the prompt submits too, bypassing the disabled Run button.
  if (!canRun.value) return;
  emit('submit', {
    repo: repo.value,
    provider: provider.value,
    model: form.model.trim(),
    prompt: form.prompt.trim(),
    skill: form.mode === 'skill' ? form.skill : '',
    worktree: form.worktree,
  });
}

const FIELD = 'control min-w-[10rem] text-ink';
</script>

<template>
  <form class="mx-auto flex w-full max-w-3xl flex-col gap-4" @submit.prevent="submit">
    <h3 class="text-base font-semibold text-ink-strong">{{ t('factory.newRequest') }}</h3>
    <div class="flex flex-wrap gap-3">
      <label class="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">{{ t('factory.repo') }}
        <select data-test="factory-repo" :class="FIELD" :value="repo" :disabled="!available" @change="form.repo = $event.target.value">
          <option v-for="name in repos" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">{{ t('factory.provider') }}
        <select data-test="factory-provider" :class="FIELD" :value="provider" :disabled="!available" @change="form.provider = $event.target.value">
          <option v-for="name in providers" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">{{ t('factory.model') }}
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

    <label v-if="form.mode === 'skill'" class="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">{{ t('factory.skill') }}
      <select v-model="form.skill" data-test="factory-skill" :class="FIELD" :disabled="!available">
        <option value="">{{ t('factory.skillNone') }}</option>
        <option v-for="skill in skills" :key="skill.id" :value="skill.id">{{ skill.id }}</option>
      </select>
    </label>

    <label class="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">{{ form.mode === 'skill' ? t('factory.extraPrompt') : t('factory.prompt') }}
      <textarea v-model="form.prompt" data-test="factory-prompt" rows="6" :class="[FIELD, '!h-auto py-2 leading-relaxed']" :disabled="!available" @keydown.enter.exact.prevent="submit" />
    </label>

    <label class="flex items-center gap-1 text-sm text-ink-soft">
      <input v-model="form.worktree" data-test="factory-worktree" type="checkbox" :disabled="!available"> {{ t('factory.worktree.option') }}
    </label>

    <p v-if="error" data-test="factory-error" class="alert text-xs"><Icon name="warning" emoji="⚠" :size="16" /> {{ error }}</p>

    <div class="flex justify-end">
      <button
        type="submit"
        data-test="factory-run"
        :disabled="!canRun"
        :aria-label="t('factory.run')"
        v-tooltip="t('factory.run')"
        class="inline-flex h-8 items-center justify-center gap-1 rounded-control bg-accent pl-2 pr-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
      ><Icon name="play_arrow" emoji="▶" /> {{ t('factory.run') }}</button>
    </div>
  </form>
</template>
