<script setup>
import { useI18n } from './i18n.js';

const { t } = useI18n();

defineProps({
  projects: { type: Array, required: true },
  selected: { type: String, default: '' },
});
const emit = defineEmits(['select', 'search']);
</script>

<template>
  <div class="flex flex-col gap-2">
    <input
      data-test="factory-search"
      type="search"
      :placeholder="t('factory.search')"
      class="rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink-soft focus:border-accent focus:outline-hidden"
      @input="emit('search', $event.target.value)"
    >
    <p v-if="projects.length === 0" class="text-xs text-ink-faint">{{ t('factory.noProjects') }}</p>
    <ul class="flex flex-col gap-1">
      <li v-for="project in projects" :key="project.repo">
        <button
          type="button"
          :data-test="`factory-project-${project.repo}`"
          :class="['flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-sm', selected === project.repo ? 'bg-surface-muted text-ink-strong font-medium' : 'text-ink-soft hover:bg-surface-hover']"
          @click="emit('select', project.repo)"
        >
          <span class="w-2 shrink-0"><span v-if="project.running" data-test="factory-running-dot" class="block h-2 w-2 rounded-full bg-accent" :title="t('factory.thread.running')" /></span>
          <span class="flex-1 truncate">{{ project.repo }}</span>
          <span class="text-xs text-ink-faint">{{ project.threads || '—' }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
