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
    class="control w-36"
    @change="setTheme($event.target.value)"
  >
    <option v-for="th in themes" :key="th.code" :value="th.code">{{ t(th.labelKey) }}</option>
  </select>
</template>
