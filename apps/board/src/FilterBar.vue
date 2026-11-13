<script setup>
import { useI18n } from './i18n.js';
import Icon from './Icon.vue';

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
    <label class="relative flex-1 min-w-[12rem] sm:max-w-xs">
      <span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-ink-faint"><Icon name="search" :size="16" /></span>
      <input
      data-test="search"
      :value="name"
      @input="$emit('update:name', $event.target.value)"
      :placeholder="t('filter.searchRepo')"
      :aria-label="t('filter.searchRepo')"
      class="control w-full pl-8 text-ink"
      />
    </label>
    <select
      data-test="tech"
      :value="tech"
      @change="$emit('update:tech', $event.target.value)"
      class="control"
    >
      <option value="">{{ t('filter.techAll') }}</option>
      <option v-for="t in technologies" :key="t" :value="t">{{ t }}</option>
    </select>
    <select
      data-test="ci"
      :value="ci"
      @change="$emit('update:ci', $event.target.value)"
      class="control"
    >
      <option value="">{{ t('filter.ciAll') }}</option>
      <option value="failure">{{ t('filter.ciFailure') }}</option>
      <option value="ok">{{ t('filter.ciOk') }}</option>
      <option value="unknown">{{ t('filter.ciUnknown') }}</option>
    </select>
  </div>
</template>
