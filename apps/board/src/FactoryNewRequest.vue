<script setup>
import { computed, reactive } from 'vue';
import Icon from './Icon.vue';
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
  emit('submit', {
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
  <form class="flex flex-col gap-3" @submit.prevent="submit">
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
</template>
