<script setup>
import { computed } from 'vue';
import { useTheme } from './theme.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();
const { theme, mode, setMode, modes, isLightOnly } = useTheme();

// A frozen theme has no dark palette, so the control goes quiet rather than
// silently doing nothing. The stored preference is untouched and applies
// again as soon as a themeable theme is selected.
const locked = computed(() => isLightOnly(theme.value));
</script>

<template>
  <select
    data-test="mode"
    :value="mode"
    :disabled="locked"
    :aria-label="t('nav.mode')"
    :title="locked ? t('mode.legacyLocked') : t('nav.mode')"
    class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
    @change="setMode($event.target.value)"
  >
    <option v-for="m in modes" :key="m.code" :value="m.code">{{ t(m.labelKey) }}</option>
  </select>
</template>
