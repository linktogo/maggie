<script setup>
import { useI18n } from './i18n.js';

const { t, locale, setLocale, locales } = useI18n();
</script>

<template>
  <select
    data-test="locale"
    :value="locale"
    :aria-label="t('nav.language')"
    :title="t('nav.language')"
    class="border border-slate-200 rounded-lg shadow-xs px-3 py-1.5 text-sm bg-white text-slate-600 focus:outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
    @change="setLocale($event.target.value)"
  >
    <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.label }}</option>
  </select>
</template>
