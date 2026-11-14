<script setup>
import { useI18n } from './i18n.js';
import Icon from './Icon.vue';

const { t } = useI18n();

defineProps({
  projects: { type: Array, required: true },
  selected: { type: String, default: '' },
});
const emit = defineEmits(['select', 'search']);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col gap-2.5 border-b border-line-soft p-3">
      <span class="eyebrow px-1">{{ t('factory.projects') }}</span>
      <label class="relative">
        <span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-ink-faint"><Icon name="search" :size="16" /></span>
        <input
          data-test="factory-search"
          type="search"
          :placeholder="t('factory.search')"
          :aria-label="t('factory.search')"
          class="control w-full pl-8 text-ink"
          @input="emit('search', $event.target.value)"
        >
      </label>
    </div>
    <p v-if="projects.length === 0" class="p-4 text-xs text-ink-faint">{{ t('factory.noProjects') }}</p>
    <ul class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      <li v-for="project in projects" :key="project.repo">
        <button
          type="button"
          :data-test="`factory-project-${project.repo}`"
          :class="['flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors', selected === project.repo ? 'bg-accent-soft text-on-accent-soft font-medium' : 'text-ink-soft hover:bg-surface-hover']"
          @click="emit('select', project.repo)"
        >
          <span class="w-2 shrink-0"><span v-if="project.running" data-test="factory-running-dot" class="status-dot-live block h-2 w-2 rounded-full bg-accent" :title="t('factory.thread.running')" /></span>
          <span class="flex-1 truncate">{{ project.repo }}</span>
          <span class="rounded-chip px-1.5 font-sans text-[11px] tabular-nums text-ink-faint">{{ project.threads || '—' }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
