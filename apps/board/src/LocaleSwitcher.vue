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
    class="border border-line rounded-control shadow-panel px-3 py-1.5 text-sm bg-surface text-ink-soft focus:outline-hidden focus:ring-2 focus:ring-accent/30 focus:border-accent"
    @change="setLocale($event.target.value)"
  >
    <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.label }}</option>
  </select>
</template>
