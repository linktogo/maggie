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
    class="control w-28"
    @change="setLocale($event.target.value)"
  >
    <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.label }}</option>
  </select>
</template>
