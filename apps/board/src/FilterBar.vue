<script setup>
import { useI18n } from './i18n.js';

const { t } = useI18n();

defineProps({
  name: { type: String, default: '' },
  tech: { type: String, default: '' },
  ci: { type: String, default: '' },
  technologies: { type: Array, default: () => [] },
});
defineEmits(['update:name', 'update:tech', 'update:ci']);
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <input
      data-test="search"
      :value="name"
      @input="$emit('update:name', $event.target.value)"
      :placeholder="t('filter.searchRepo')"
      class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface flex-1 min-w-0 focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    />
    <select
      data-test="tech"
      :value="tech"
      @change="$emit('update:tech', $event.target.value)"
      class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-soft focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    >
      <option value="">{{ t('filter.techAll') }}</option>
      <option v-for="t in technologies" :key="t" :value="t">{{ t }}</option>
    </select>
    <select
      data-test="ci"
      :value="ci"
      @change="$emit('update:ci', $event.target.value)"
      class="border border-line rounded-control px-3 py-1.5 text-sm bg-surface text-ink-soft"
    >
      <option value="">{{ t('filter.ciAll') }}</option>
      <option value="failure">{{ t('filter.ciFailure') }}</option>
      <option value="ok">{{ t('filter.ciOk') }}</option>
      <option value="unknown">{{ t('filter.ciUnknown') }}</option>
    </select>
  </div>
</template>
