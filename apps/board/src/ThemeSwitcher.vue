<script setup>
import { useTheme } from './theme.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();
const { theme, setTheme, themes } = useTheme();
</script>

<template>
  <select
    data-test="theme"
    :value="theme"
    :aria-label="t('nav.theme')"
    :title="t('nav.theme')"
    class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    @change="setTheme($event.target.value)"
  >
    <option v-for="th in themes" :key="th.code" :value="th.code">{{ t(th.labelKey) }}</option>
  </select>
</template>
